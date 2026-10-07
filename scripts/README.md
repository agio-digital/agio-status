# Agio Status

Upptime's existing frontend, with a Yarn patch that reads build-time snapshots instead of asking visitors to access GitHub. Monitoring stays in Upptime; publication is handled by `Publish patched Upptime`.

Run `yarn install --immutable`, `yarn test`, then `GH_TOKEN=… yarn build`. Keep the template's Setup CI and Static Site CI publishers disabled to prevent an unpatched frontend being deployed. Package upgrades must apply the patch and pass the checks before publication.
