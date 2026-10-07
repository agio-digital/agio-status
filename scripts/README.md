# Status publication

`build-status.mjs` publishes probe history and incident snapshots as static HTML and JSON. GitHub credentials are used only during the build; visitors make no API requests. Failed snapshot reads stop publication, and old checks show a delayed-update warning.

`Publish status snapshot` owns Pages deployment. Keep the template's **Setup CI** and **Static Site CI** workflows disabled: their frontend calls GitHub from visitors' browsers. Upptime monitoring, summaries, graphs and Slack notifications remain separate.

Run `node --test scripts/build-status.test.mjs` to check publication behavior.
