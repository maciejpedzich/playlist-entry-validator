import { Probot } from 'probot';
import getMetaData from 'metadata-scraper';

import { getPlaylistIdFromUrl } from './getPlaylistIdFromUrl';

type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';

const appFn = (app: Probot) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async ({ payload, octokit }) => {
      console.log('Pull Request Handler triggered');

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

        const { data: prFiles } = await octokit.pulls.listFiles({
          ...workingRepo,
          pull_number
        });

        const filesToVerify = prFiles.filter(
          ({ status, filename }) =>
            filename.startsWith(registryDirectoryPath) &&
            ['added', 'modified'].includes(status)
        );

        if (filesToVerify.length === 0) return;

        const playlistSearchResults = await Promise.all(
          filesToVerify.map(async ({ filename }) => {
            const filenameWithoutRegistryPath = removeRegistryPathFromFilename(
              filename
            ).replace('https:/', 'https://');

            const url = getPlaylistIdFromUrl(filenameWithoutRegistryPath)
              ? filenameWithoutRegistryPath
              : `https://open.spotify.com/playlist/${filenameWithoutRegistryPath}`;

            const spotifyResponse = await fetch(url);
            const expectedStatusCodes = [200, 400, 404];

            if (!expectedStatusCodes.includes(spotifyResponse.status)) {
              throw new Error(`Spotify ${spotifyResponse.status}`);
            }

            const found = spotifyResponse.status === 200;
            let details = '';

            if (found) {
              const html = await spotifyResponse.text();
              const { title, description } = await getMetaData({ html });
              const playlistMeta = (description || '')
                .split(' · ')
                .filter((text) => text !== 'Playlist');

              console.log(details);
              details = [title, ...playlistMeta].join(' · ');
            }

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

          const forkPageUrl = payload.pull_request.head.repo.html_url;
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
      } catch (error) {
        console.error(error);
        await upsertReview(
          undefined,
          'COMMENT',
          `Something went wrong while validating new entries! @${workingRepo.owner} should handle it shortly...`
        );
      }
    }
  );
};

export = appFn;
