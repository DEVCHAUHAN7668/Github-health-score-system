import { Router } from 'express';
import { githubService } from '../services/githubService.js';
import { calculateHealthScore } from '../services/healthScoreService.js';
import { InvalidRepositoryUrlError, parseRepositoryUrl } from '../utils/repositoryUrl.js';

export function createRepositoryRouter(options = {}) {
  const {
    analyzeRepository = (repository) => githubService.analyze(repository),
    scoreRepository = calculateHealthScore,
  } = typeof options === 'function' ? { analyzeRepository: options } : options;
  const router = Router();

  router.post('/analyze', async (request, response, next) => {
    try {
      const body = request.body ?? {};
      const repository = parseRepositoryUrl(body.url ?? body.repositoryUrl);
      const data = await analyzeRepository(repository);
      const health = scoreRepository(data);
      const analyzedAt = new Date().toISOString();
      const result = {
        ...data,
        health,
        metadata: { analyzedAt, dataSource: 'GitHub REST API' },
      };
      response.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof InvalidRepositoryUrlError) {
        return response.status(400).json({ success: false, error: { code: 'INVALID_REPOSITORY_URL', message: error.message } });
      }
      return next(error);
    }
  });

  return router;
}

export default createRepositoryRouter();
