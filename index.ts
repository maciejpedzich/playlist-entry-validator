import { ApplicationFunction } from 'probot';

const appFn: ApplicationFunction = (app) => {
  app.on('pull_request', (context) => {
    console.log(JSON.stringify(context.payload, null, 2));
  });
};

export = appFn;
