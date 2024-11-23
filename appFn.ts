import { setTimeout } from 'timers/promises';
import { ApplicationFunction, Probot } from 'probot';
import { throttleAll } from 'promise-throttle-all';
import getMetaData from 'metadata-scraper';

import { getPlaylistIdFromUrl } from './getPlaylistIdFromUrl';

type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';

const appFn: ApplicationFunction = (app: Probot, { getRouter }) => {
  getRouter!('/ping').get('/pong', (_, res) => res.sendStatus(200));

  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async ({ payload, octokit, log }) => {
      const registryDirectoryPath = 'playlists/registry/';
      const siQueryStart = '?si=';

      const pull_number = payload.number;
      const workingRepo = {
        owner: payload.repository.owner.login,
        repo: payload.repository.name
      };

      const removeRegistryPathFromFilename = (filename: string) =>
        filename.replace(registryDirectoryPath, '');

      const upsertReview = async (
        review_id: number | undefined,
        event: ReviewEvent,
        body: string
      ) => {
        if (review_id) {
          await octokit.pulls.updateReview({
            ...workingRepo,
            pull_number,
            review_id,
            body
          });
        } else {
          await octokit.pulls.createReview({
            ...workingRepo,
            pull_number,
            event,
            body
          });
        }
      };

      const repoAllowlist = [
        { owner: 'mackorone', repo: 'spotify-playlist-archive' },
        { owner: 'maciejpedzich', repo: 'bot-testing-ground' }
      ];

      try {
        const isAllowlistedRepo = repoAllowlist.find(
          ({ owner, repo }) =>
            workingRepo.owner === owner && workingRepo.repo === repo
        );

        if (!isAllowlistedRepo) return;

        type PRFileArray = Awaited<
          ReturnType<typeof octokit.pulls.listFiles>
        >['data'];

        const prFiles: PRFileArray = [];
        let page = 1;
        let isLoadingPages = true;
        let timeToRateLimitReset = 0;

        while (isLoadingPages) {
          await setTimeout(timeToRateLimitReset);

          const { data, headers } = await octokit.pulls.listFiles({
            ...workingRepo,
            pull_number,
            page
          });

          prFiles.push(...data);

          let now = Date.now();
          timeToRateLimitReset =
            headers['x-ratelimit-remaining'] !== '0'
              ? 0
              : (Number(headers['x-ratelimit-reset']) || now) - now;

          if (headers.link?.includes(`rel=\"next\"`)) page++;
          else isLoadingPages = false;
        }

        const filesToVerify = prFiles.filter(
          ({ status, filename }) =>
            filename.startsWith(registryDirectoryPath) &&
            ['added', 'modified'].includes(status)
        );

        if (filesToVerify.length === 0) return;

        let numEntriesBeforeCooldown = 3;
        let numProcessedEntries = 0;
        let cooldownTimeout = 1500;

        const playlistSearchResults = await throttleAll(
          1,
          filesToVerify.map(({ filename }) => async () => {
            const filenameWithoutRegistryPath = removeRegistryPathFromFilename(
              filename
            ).replace('https:/', 'https://');

            const url = getPlaylistIdFromUrl(filenameWithoutRegistryPath)
              ? filenameWithoutRegistryPath
              : `https://open.spotify.com/playlist/${filenameWithoutRegistryPath}`;

            if (
              numProcessedEntries > 0 &&
              numProcessedEntries % numEntriesBeforeCooldown === 0
            )
              await setTimeout(cooldownTimeout);

            const spotifyResponse = await fetch(url);
            const expectedStatusCodes = [200, 400, 404];

            if (!expectedStatusCodes.includes(spotifyResponse.status))
              throw new Error(
                `Received ${spotifyResponse.status} status code from ${url}`
              );

            const found = spotifyResponse.status === 200;
            let details = '';

            if (found) {
              const html = await spotifyResponse.text();
              const {
                // author: authorUrl,
                description,
                title
              } = await getMetaData({
                html,
                customRules: {
                  author: {
                    rules: [
                      [
                        'meta[name="music:creator"]',
                        (e) => e.getAttribute('content')
                      ]
                    ]
                  }
                }
              });

              // let authorName = (authorUrl as string).endsWith('/user/spotify')
              //   ? 'Spotify'
              //   : '';

              // if (authorName === '') {
              //   const playlistAuthorResponse = await fetch(authorUrl as string);

              //   if (!playlistAuthorResponse.ok)
              //     throw new Error(
              //       `Received ${playlistAuthorResponse.status} status code from ${authorUrl}`
              //     );

              //   const authorPageHtml = await playlistAuthorResponse.text();
              //   const { title: authorPageTitle } = await getMetaData({
              //     html: authorPageHtml
              //   });

              //   authorName = authorPageTitle as string;
              // }

              // const playlistMeta = (description || '')
              //   .split(' · ')
              //   .filter((text) => text !== 'Playlist')
              //   .concat(authorName as string);

              // details = playlistMeta.join(' · ');
              details = title! + '· ' + description;
            }

            numProcessedEntries++;

            return {
              filename: filenameWithoutRegistryPath,
              found,
              details,
              url
            };
          })
        );

        let successText = `🎉 @${workingRepo.owner} can merge your pull request! 🎉`;
        let reviewEvent: ReviewEvent = 'APPROVE';

        let identifiedPlaylistsText = '';
        const validEntries = playlistSearchResults.filter(
          ({ found, filename, url }) =>
            found && !filename.includes(siQueryStart) && filename !== url
        );

        if (validEntries.length > 0) {
          const playlistLinks = validEntries
            .map(({ url, details }) => `- [${details}](${url})`)
            .join('\n');

          identifiedPlaylistsText = `### ✅ These playlists have been indentified:\n${playlistLinks}`;
        }

        let renameRequiredText = '';
        const entriesToRename = playlistSearchResults.filter(
          ({ found, filename }) =>
            found &&
            filename.includes(siQueryStart) &&
            !getPlaylistIdFromUrl(filename)
        );

        if (entriesToRename.length > 0) {
          const renameList = entriesToRename
            .map(({ filename }) => {
              const filenameWithoutRegistryPath =
                removeRegistryPathFromFilename(filename);

              const [targetFilename] =
                filenameWithoutRegistryPath.split(siQueryStart);

              return `- From \`${filenameWithoutRegistryPath}\` to **${targetFilename}**`;
            })
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          renameRequiredText = `### ⚠️ You have to rename these entries:\n${renameList}`;
        }

        let urlEntriesToRenameText = '';
        const urlFilenameEntries = playlistSearchResults.filter(
          ({ filename, url }) => filename === url
        );

        if (urlFilenameEntries.length > 0) {
          successText = '';

          const forkPageUrl = payload.pull_request.head.repo?.html_url;
          const httpsDirUrl = `${forkPageUrl}/tree/main/playlists/registry/https:`;

          const baseCreateUrl = `${forkPageUrl}/new/main/playlists/registry/FOO`;
          const linkList = urlFilenameEntries.map(({ url }) => {
            const playlistId = getPlaylistIdFromUrl(url);
            const createFilePageUrl = `${baseCreateUrl}?filename=${playlistId}&value=REMOVE%20THIS%20TEXT%20FIRST`;

            return `\t- [Create \`${playlistId}\`](${createFilePageUrl})`;
          });

          reviewEvent = 'REQUEST_CHANGES';
          urlEntriesToRenameText = `### ⚠️ Some entries are malformed playlist URLs\n\nHere's how you can correct them:\n\n1. Go to [the \`https:\` folder](${httpsDirUrl}), click on the three dots on the right-hand side, and choose _Delete directory_\n\n2. Use the links below to create valid entries:\n${linkList}`;
        }

        let notFoundText = '';
        const notFoundPlaylists = playlistSearchResults.filter(
          ({ found }) => !found
        );

        if (notFoundPlaylists.length > 0) {
          const notFoundList = notFoundPlaylists
            .map(({ filename }) => `- ${filename}`)
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          notFoundText = `### ❌ These entries don't point to any existing public playlists:\n${notFoundList}`;
        }

        const reviewBody = [
          identifiedPlaylistsText,
          renameRequiredText,
          urlEntriesToRenameText,
          notFoundText,
          successText
        ]
          .filter(Boolean)
          .join('\n\n');

        const { data: reviews } = await octokit.pulls.listReviews({
          ...workingRepo,
          pull_number
        });
        const [existingReview] = reviews;

        await upsertReview(existingReview?.id, reviewEvent, reviewBody);
      } catch (e) {
        const error = e as Error;

        log.error({ stack: error?.stack }, error.message);
        await upsertReview(
          undefined,
          'COMMENT',
          `Something went wrong while validating new entries! @${workingRepo.owner} should handle it shortly.`
        );
      }
    }
  );
};

export = appFn;
