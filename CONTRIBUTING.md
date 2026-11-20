# Contributing

Thanks for helping. A few rules keep the project working on old TVs.

## Before you start

* Open an issue first for anything bigger than a small fix, so we can agree on the approach.
* By contributing you agree your work is licensed under the same terms as the part you change
  (GPL-3.0-or-later for the apps, AGPL-3.0-or-later for `server/`). Add a `Signed-off-by:` line to each commit
  (`git commit -s`) to confirm you have the right to submit it.

## Web code rules (`web/`)

* **ES5 only.** No arrow functions, `let`/`const`, template literals or `class`. Older TV browsers do not support them.
  No backticks, even in comments.
* No diagnostic logging in code that ships (no `console.log` left behind).
* Every user-facing string goes in the translation files. All languages must have the same keys and the same
  `{placeholders}`.
* TV navigation is by remote control. Anything you add must be reachable with the arrow keys, OK and Back.
* `tv-720.css` is generated. Never edit it by hand.

## Checks

Run `NM=<node_modules> bash tools/run-gates.sh`. It must end with `overall fail=0`. For the server, run `npm test` in `server/`.

## Comments

Write comments that say what the code does and why. Do not put issue numbers, names of people or providers, or
version history in comments.

## Kotlin and Gradle

Android changes need a real device build and test; they cannot be checked by the gates alone.

## Security

Please do not open a public issue for a security problem. Report it privately to the maintainer.
