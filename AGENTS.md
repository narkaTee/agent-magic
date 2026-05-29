# Magic Agent Stuff

## pi Extensions

Extensions for pi/pi-coding-agent live in ./pi-extensions.
When working in this repo, add or update extensions there.

You can consult the source code in the folder pi-mono for reference, but do not modify code in pi-mono.
Pull it to make sure the code is up to date.
If it does not exist yet clone it from here: https://github.com/badlogic/pi-mono.git

## Coding Style
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers

## Checks
- After code changes (non-doc changes), run `npm run check`.
- Fix all reported issues before finishing.
