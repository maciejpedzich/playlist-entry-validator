import {
  createLambdaFunction,
  createProbot
} from '@probot/adapter-aws-lambda-serverless';

import { appFn } from '../../app';

const privateKey = (process.env.PRIVATE_KEY as string).replace(/\\n/gm, '\n');

const handler = createLambdaFunction(appFn, {
  probot: createProbot({ overrides: { privateKey } })
});

export { handler };
