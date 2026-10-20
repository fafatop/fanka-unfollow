# Fanka Unfollow

A Loon plugin for managing Finka accounts that do not follow back, including followed accounts that have been banned or deactivated.

## Features

- Captures both non-mutual-follow and banned/deactivated account lists.
- Follows every cursor page and removes duplicate accounts.
- Runs ordinary unfollow requests with bounded concurrency and automatic retry/backoff.
- Shows live processed, successful, failed, and remaining counts.
- Displays a progress bar that refreshes about every 500 milliseconds.
- Sends a rate-limited Loon notification that opens the local control page.
- Stores account IDs and progress only in Loon's local persistent storage.

## Requirements

- iOS only.
- Allow Loon notifications in iOS Settings.
- Loon 3.5.1 (983) or later.
- Enable Script, Rewrite, and MITM in Loon.
- Install and trust the Loon MITM certificate.

## Installation

[One-click Import](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Ffafatop%2Ffanka-unfollow%2Fmain%2Fmain.plugin)

Manual plugin URL:

```text
https://raw.githubusercontent.com/fafatop/fanka-unfollow/main/main.plugin
```

## Usage

1. Enable the plugin and Loon.
2. Open either the non-mutual-follow list or the banned/deactivated account list in Finka.
3. Tap the Loon notification to open the local control page.
4. Select `获取完整名单` to retrieve both lists and all cursor pages.
5. Verify the total, then select `一键取关全部剩余用户`.
6. Keep the page open to watch live progress. The stop control prevents a new round from starting after the current round completes.

## Privacy

The plugin does not upload the captured account list. It stores the list, request context, and progress locally through Loon's `$persistentStore`. Authentication headers are used only for requests from the local Loon script to Finka's API.

## Notes

- The plugin automates normal per-account unfollow requests; it does not modify membership status.
- Finka may change its API at any time. Review failures shown on the progress page before retrying.
- Use this plugin only with your own account and at your own discretion.

## License

MIT

