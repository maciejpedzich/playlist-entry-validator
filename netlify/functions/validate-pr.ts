import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { createProbot } from 'probot';

import { appFn } from '../../appFn';

const privateKey = (process.env.PRIVATE_KEY as string).replace(/\\n/gm, '\n');

const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  const probot = createProbot({ overrides: { privateKey } });

  await appFn(probot);

  return {
    statusCode: 200,
    body: 'Playlist Entry Validator by Maciej Pędzich'
  };
};

export { handler };
