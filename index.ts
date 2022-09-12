import { ApplicationFunction } from 'probot';

const appFn: ApplicationFunction = (app) => {
  app.onAny((context) => console.log(JSON.stringify(context, null, 2)));
};

export = appFn;
