import { ApplicationFunction } from 'probot';

const bot: ApplicationFunction = (app) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      const registryDirectoryPath = 'playlists/registry/';
      const siQueryStart = '?si=';

      const loginAllowlist = ['mackorone', 'maciejpedzich'];
      const repoAllowlist = ['spotify-playlist-archive', 'bot-testing-ground'];

      const pull_number = context.payload.number;
      const repoData = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name
      };

      if (
        !(
          loginAllowlist.includes(repoData.owner) &&
          repoAllowlist.includes(repoData.repo)
        )
      )
        return;

      const removePathFromFilename = (filename: string) =>
        filename.replace(registryDirectoryPath, '');

      const upsertReview = async (body: string, review_id?: number) => {
        if (review_id) {
          await context.octokit.pulls.updateReview({
            ...repoData,
            pull_number,
            review_id,
            body
          });
        } else {
          await context.octokit.pulls.createReview({
            ...repoData,
            pull_number,
            event: 'REQUEST_CHANGES',
            body
          });
        }
      };

      try {
        const { data: prFiles } = await context.octokit.pulls.listFiles({
          ...repoData,
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
          ...repoData,
          pull_number
        });

        const [existingReview] = priorReviews;

        if (notFoundPlaylists.length > 0) {
          const renameList = notFoundPlaylists
            .map(({ filename }) => `- ${filename}`)
            .join('\n');

          const body = `It looks like the following playlists don't exist:\n${renameList}`;

          await upsertReview(body, existingReview?.id);
        } else if (filesWithSiQuery.length > 0) {
          const renameList = filesWithSiQuery
            .map(({ filename }) => {
              const filenameWithoutPath = removePathFromFilename(filename);
              const [targetFilename] = filenameWithoutPath.split(siQueryStart);

              return `- Rename ${filenameWithoutPath} to **${targetFilename}**`;
            })
            .join('\n');

          const body = `Almost there! You just have to:\n${renameList}`;

          await upsertReview(body, existingReview?.id);
        } else {
          if (existingReview) {
            await context.octokit.pulls.dismissReview({
              ...repoData,
              pull_number,
              review_id: existingReview.id,
              message: 'All entries can now be accepted.'
            });
          }

          await context.octokit.pulls.merge({
            ...repoData,
            pull_number
          });
        }
      } catch (error) {
        await context.octokit.pulls.createReview({
          ...repoData,
          pull_number,
          event: 'COMMENT',
          body: 'Something went wrong while verifying changes! @mackorone should handle it shortly.'
        });
      }
    }
  );
};

export = bot;
