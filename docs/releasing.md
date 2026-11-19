# Releasing to npm

## The first release (one time, by hand)

npm can only set up automatic publishing for a package that already exists.
So the first version is published from your own computer.

1. Create an account on [npmjs.com](https://www.npmjs.com/signup) and turn on two-factor authentication.
2. In the repo folder:

    ```bash
    npm login
    npm install
    npm test
    npm publish
    ```

3. Check the page: https://www.npmjs.com/package/mcp-effect

## Turn on automatic releases (one time)

1. Open https://www.npmjs.com/package/mcp-effect and go to the **Settings** tab.
2. Find **Trusted Publisher** and choose **GitHub Actions**.
3. Fill in:

    | Field                | Value             |
    | -------------------- | ----------------- |
    | Organization or user | `lilyanAhmetoglu` |
    | Repository           | `mcp-effect`      |
    | Workflow filename    | `release.yml`     |
    | Environment name     | leave empty       |

4. Under allowed actions, allow **npm publish**.
5. Do the next release within 2 days. npm removes a trusted publisher that is not used in that time.

After this, no npm token is stored anywhere.

## Every later release

```bash
npm version patch        # or: minor, major. This edits package.json and makes a git tag.
git push --follow-tags
```

The `Release` workflow runs the tests and publishes. Add a line to `CHANGELOG.md` first.

## If the release workflow fails

- **"Tag does not match package.json"**: the tag and the version differ. Use `npm version`, do not tag by hand.
- **An auth error from npm**: check the four fields above. npm does not check them when you save. Errors show up only on publish.
- **The trusted publisher expired**: delete it on npmjs.com, add it again, and release within 2 days.
