# Tests

Run against a mock reporting API rather than the live one, so they are fast, offline and
deterministic — and so the mock can reproduce the things the real API does that nothing
would predict: refusing an interval query with no `facet_field`, answering `Invalid
Number` when a numeric id filter is given anything but one number, and 406-ing the user
search unless the Accept header is `application/vnd.api+json`. When the mock is more
permissive than the real thing, the tests pass and the feature ships broken; that has
happened once already.

```
npm install
npm install --no-save --prefix /tmp/pd gridstack@10.3.1 echarts@5.5.1   # page libs
node test/test-tooltip-ui.mjs
```

`CHART_LIBS` points at the folder holding gridstack + echarts (default
`/tmp/pd/node_modules`), `PLAYWRIGHT_PKG` at an installed playwright, and
`TEST_WORK_DIR` at scratch space (default `test/.work`). Nothing here touches the live
Pronto API or the deployed app.
