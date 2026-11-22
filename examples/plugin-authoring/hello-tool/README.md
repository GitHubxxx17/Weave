# Hello Tool source example

This is Weave-authored source, not an installable payload or a published release.
From the Weave checkout, use `pnpm plugin:validate --source` with this directory,
then `pnpm plugin:build --source` with a new output directory outside the source.
Install the reported `payload` child only after normal review and activation.

The CLI uses its real current local SDK for type checking; no author dependencies
or scripts are installed or executed. The tool returns supplied text and gains
no additional filesystem, process or management access. Actual tool execution
belongs to Weave's shared Tool Pipeline.
