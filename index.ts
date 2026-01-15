import { run } from 'probot';
import appFn from './appFn';

run(appFn).then((server) => {
  process.on('SIGTERM', async () => {
    await server.stop();
  });
});
