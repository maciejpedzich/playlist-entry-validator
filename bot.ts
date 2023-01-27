import { ApplicationFunction } from 'probot';
import getMetaData from 'metadata-scraper';

import { getPlaylistIdFromUrl } from './getPlaylistIdFromUrl';

type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';

export const bot: ApplicationFunction = (app) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async ({ payload, octokit }) => {
      const registryDirectoryPath = 'playlists/registry/';
      const siQueryStart = '?si=';

      const pull_number = payload.number;
      const workingRepo = {
        owner: payload.repository.owner.login,
        repo: payload.repository.name
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

      try {
        const isAllowlistedRepo = repoAllowlist.find(
          ({ owner, repo }) =>
            workingRepo.owner === owner && workingRepo.repo === repo
        );

        if (!isAllowlistedRepo) return;

        const { data: prFiles } = await octokit.pulls.listFiles({
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

            const url = getPlaylistIdFromUrl(filename)
              ? filename
              : `https://open.spotify.com/playlist/${filenameWithoutPath}`;

            const spotifyResponse = await fetch(url);
            const expectedStatusCodes = [200, 404];

            if (!expectedStatusCodes.includes(spotifyResponse.status)) {
              throw new Error(
                `${spotifyResponse.url} responded with ${spotifyResponse.status}`
              );
            }

            const found = spotifyResponse.status === 200;
            let info = '';

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

        const entriesToRename = playlistLookupResults.filter(
          ({ found, filename }) =>
            found &&
            (filename.includes(siQueryStart) || getPlaylistIdFromUrl(filename))
        );

        const notFoundPlaylists = playlistLookupResults.filter(
          ({ found }) => !found
        );

        const { data: priorReviews } = await octokit.pulls.listReviews({
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

        if (entriesToRename.length > 0) {
          const renameList = entriesToRename
            .map(({ filename }) => {
              const playlistIdFromPossibleUrl = getPlaylistIdFromUrl(filename);
              const filenameWithoutPath = removePathFromFilename(filename);

              const targetFilename =
                playlistIdFromPossibleUrl ||
                filenameWithoutPath.replace(siQueryStart, '');

              return `- From ${filenameWithoutPath} to **${targetFilename}**`;
            })
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          renameRequiredText = `### ⚠️ These entries have to be renamed:\n${renameList}`;
        }

        if (notFoundPlaylists.length > 0) {
          const renameList = notFoundPlaylists
            .map(({ filename }) => `- ${filename}`)
            .join('\n');

          successText = '';
          reviewEvent = 'REQUEST_CHANGES';
          notFoundText = `### ❌ Playlists for these entries don't exist:\n${renameList}`;
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

        await octokit.pulls.createReview({
          ...workingRepo,
          pull_number,
          event: 'COMMENT',
          body: `Something went wrong while validating new entries! @${workingRepo.owner} should handle it shortly...`
        });
      }
    }
  );
};
