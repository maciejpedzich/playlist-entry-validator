import { readdirSync } from 'fs';

console.log(readdirSync('/var/task/netlify/functions/validate-pr'));

process.chdir('/var/task/netlify/functions/validate-pr');

import {
  createProbot,
  createLambdaFunction
} from '@probot/adapter-aws-lambda-serverless';

import { appFn } from '../../../appFn';

const privateKey = (process.env.PRIVATE_KEY as string).replace(/\\n/gm, '\n');

const handler = createLambdaFunction(appFn, {
  probot: createProbot({ overrides: { privateKey } })
});

export { handler };
