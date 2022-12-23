import { ApplicationFunction } from 'probot';
import getMetaData from 'metadata-scraper';

type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';

const bot: ApplicationFunction = (app) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      const registryDirectoryPath = 'playlists/registry/';
      const siQueryStart = '?si=';

      const pull_number = context.payload.number;
      const workingRepo = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name
      };

      const repoAllowlist = [
        { owner: 'mackorone', repo: 'spotify-playlist-archive' },
        { owner: 'maciejpedzich', repo: 'bot-testing-ground' }
      ];

      const removePathFromFilename = (filename: string) =>
        filename.replace(registryDirectoryPath, '');

      const upsertReview = async (
        review_id: number | undefined,
        body: string,
        event: ReviewEvent
      ) => {
        if (review_id) {
          await context.octokit.pulls.updateReview({
            ...workingRepo,
            pull_number,
            review_id,
            body
          });
        } else {
          await context.octokit.pulls.createReview({
            ...workingRepo,
            pull_number,
            event,
            body
          });
        }
      };

      try {
        const isAllowlistedRepo = repoAllowlist.find(
          ({ owner, repo }) =>
            workingRepo.owner === owner && workingRepo.repo === repo
        );

        if (!isAllowlistedRepo) return;

        const { data: prFiles } = await context.octokit.pulls.listFiles({
          ...workingRepo,
          pull_number
        });

        const filesToVerify = prFiles.filter(
          ({ status, filename }) =>
            status === 'added' && filename.startsWith(registryDirectoryPath)
        );

        if (filesToVerify.length === 0) return;

        const playlistLookupResults = await Promise.all(
          filesToVerify.map(async ({ filename }) => {
            const filenameWithoutPath = removePathFromFilename(filename);
            const url = `https://open.spotify.com/playlist/${filenameWithoutPath}`;
            const expectedStatusCodes = [200, 404];

            const spotifyResponse = await fetch(url);

            if (!expectedStatusCodes.includes(spotifyResponse.status))
              throw new Error(
                `${spotifyResponse.url} responded with code ${spotifyResponse.status}`
              );

            const found = spotifyResponse.status === 200;
            let info: string | null = null;

            if (found) {
              const html = await spotifyResponse.text();
              const { title, description } = await getMetaData({ html });
              const playlistMeta = (description || '')
                .split(' · ')
                .filter((text) => text !== 'Playlist');

              info = [title, ...playlistMeta].join(' · ');
            }

            return {
              filename: removePathFromFilename(filename),
              found,
              info,
              url
            };
          })
        );

        const validEntries = playlistLookupResults.filter(
          ({ found, filename }) => found && !filename.includes(siQueryStart)
        );

        const entriesWithSiQuery = playlistLookupResults.filter(
          ({ found, filename }) => found && filename.includes(siQueryStart)
        );

        const notFoundPlaylists = playlistLookupResults.filter(
          ({ found }) => !found
        );

        const { data: priorReviews } = await context.octokit.pulls.listReviews({
          ...workingRepo,
          pull_number
        });

        const [existingReview] = priorReviews;

        let identifiedPlaylistsText = '';
        let renameRequiredText = '';
        let notFoundText = '';
        let successText = `🎉 @${workingRepo.owner} can merge your pull request! 🎉`;
        let reviewEvent: ReviewEvent = 'APPROVE';

        if (validEntries.length > 0) {
          const playlistLinks = validEntries
            .map(({ url, info }) => `- [${info}](${url})`)
            .join('\n');

          identifiedPlaylistsText = `### ✅ These playlists have been indentified:\n${playlistLinks}`;
        }

        if (notFoundPlaylists.length > 0) {
          const renameList = notFoundPlaylists
            .map(({ filename }) => `- ${filename}`)
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          notFoundText = `### ❌ Playlists for these entries don't exist:\n${renameList}`;
        }

        if (entriesWithSiQuery.length > 0) {
          const renameList = entriesWithSiQuery
            .map(({ filename }) => {
              const filenameWithoutPath = removePathFromFilename(filename);
              const [targetFilename] = filenameWithoutPath.split(siQueryStart);

              return `- From ${filenameWithoutPath} to **${targetFilename}**`;
            })
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          renameRequiredText = `### ⚠️ These entries have to be renamed:\n${renameList}`;
        }

        const reviewBody = [
          identifiedPlaylistsText,
          renameRequiredText,
          notFoundText,
          successText
        ]
          .filter(Boolean)
          .join('\n\n');

        await upsertReview(existingReview?.id, reviewBody, reviewEvent);
      } catch (error) {
        console.error(error);

        await context.octokit.pulls.createReview({
          ...workingRepo,
          pull_number,
          event: 'COMMENT',
          body: `Something went wrong while validating new entries! @${workingRepo.owner} should handle it shortly...`
        });
      }
    }
  );
};

export = bot;
