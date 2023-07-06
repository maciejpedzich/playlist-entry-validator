import { readdirSync } from 'fs';

console.log('/var/runtime:\n' + readdirSync('/var/runtime'));

process.chdir('/var/runtime');

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
