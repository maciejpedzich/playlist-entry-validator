import { ApplicationFunction } from 'probot';

const appFn: ApplicationFunction = (app) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      const registryDirectoryPath = 'playlists/registry/';
      const siQueryStart = '?si=';
      const pull_number = context.payload.number;
      const repo = {
        owner: 'mackorone',
        repo: 'spotify-playlist-archive'
      };

      const removePathFromFilename = (filename: string) =>
        filename.replace(registryDirectoryPath, '');

      const upsertReview = async (body: string, review_id: number) => {
        if (review_id) {
          await context.octokit.pulls.updateReview({
            ...repo,
            pull_number,
            review_id,
            body
          });
        } else {
          await context.octokit.pulls.createReview({
            ...repo,
            pull_number,
            event: 'REQUEST_CHANGES',
            body
          });
        }
      };

      try {
        const { data: prFiles } = await context.octokit.pulls.listFiles({
          ...repo,
          pull_number
        });

        const filesToVerify = prFiles.filter(
          ({ status, filename }) =>
            status === 'added' && filename.startsWith(registryDirectoryPath)
        );

        const filesWithSiQuery = filesToVerify.filter(({ filename }) =>
          filename.includes(siQueryStart)
        );

        const playlistLookupResults = await Promise.all(
          filesToVerify.map(async ({ filename }) => {
            const filenameWithoutPath = removePathFromFilename(filename);
            const spotifyResponse = await fetch(
              `https://open.spotify.com/playlist/${filenameWithoutPath}`
            );

            return {
              filename: removePathFromFilename(filename),
              found: spotifyResponse.status === 200
            };
          })
        );

        const notFoundPlaylists = playlistLookupResults.filter(
          ({ found }) => !found
        );

        const { data: priorReviews } = await context.octokit.pulls.listReviews({
          ...repo,
          pull_number
        });

        const [existingReview] = priorReviews;

        if (notFoundPlaylists.length > 0) {
          const renameList = notFoundPlaylists
            .map(({ filename }) => `- ${filename}`)
            .join('\n');

          const body = `It looks like the following playlists don't exist: ${renameList}`;

          await upsertReview(body, existingReview?.id);
        } else {
          if (filesWithSiQuery.length > 0) {
            const renameList = filesWithSiQuery
              .map(({ filename }) => {
                const filenameWithoutPath = removePathFromFilename(filename);
                const [targetFilename] =
                  filenameWithoutPath.split(siQueryStart);

                return `- Rename ${filenameWithoutPath} to **${targetFilename}**`;
              })
              .join('\n');

            const body = `In order for me to accept changes, you have to: ${renameList}`;

            await upsertReview(body, existingReview?.id);
          } else {
            if (existingReview) {
              await context.octokit.pulls.dismissReview({
                ...repo,
                pull_number,
                review_id: existingReview.id,
                message: 'Changes can now be accepted!'
              });
            }

            await context.octokit.pulls.merge({
              ...repo,
              pull_number
            });
          }
        }
      } catch (error) {
        console.error(error);

        await context.octokit.pulls.createReview({
          ...repo,
          pull_number,
          event: 'COMMENT',
          body: 'Something went wrong while performing automatic verification! @mackorone should handle it manually.'
        });
      }
    }
  );
};

export = appFn;
