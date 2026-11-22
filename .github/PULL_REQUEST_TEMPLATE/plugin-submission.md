## Plugin submission

Plugin ID:

Publisher:

Source repository:

Fixed commit and subdirectory:

Version(s):

Describe the plugin and why it is useful. Explain the requested permissions and
contributions, including any changes from previously listed versions.

## Author validation

- [ ] The source contains `weave-plugin.json` and an already bundled single-file
      ESM entry, without dependencies that users must build or install.
- [ ] Every release uses a full lowercase 40-character Git commit, with the
      correct subdirectory and full manifest copied from that exact source.
- [ ] New releases are appended; existing version/source/manifest records have
      not been silently replaced.
- [ ] I ran `pnpm marketplace:generate` and `pnpm marketplace:check` and included
      both the submission and generated index changes.
- [ ] I explained the publisher identity and the relationship to the source
      repository. I understand directory inclusion does not certify the author
      or grant user trust.

## Reviewer checks

- [ ] Validate repository/publisher attribution and check for conflicting IDs.
- [ ] Compare every manifest with the pinned descriptor and inspect the bundled
      code, permissions and declared contributions.
- [ ] Confirm the requested version update preserves existing immutable records.
- [ ] Confirm CI, schema validation and deterministic index checks pass.
