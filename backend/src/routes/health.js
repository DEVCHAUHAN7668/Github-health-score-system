import { Router } from 'express';

const router = Router();

router.get('/', (_request, response) => {
  response.json({ status: 'ok', service: 'github-repository-health-analyzer' });
});

export default router;
