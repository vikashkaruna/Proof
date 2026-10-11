# private-docs (operator-internal, git-ignored)

Only this README is tracked; everything else here is ignored by `.gitignore`
and blocked by the commit guard and CI. Start at [`INDEX.md`](INDEX.md) on a
machine where the folder has been restored.

| Folder          | Content                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `operator/`     | `OPS-<MM>-<module>.md` step-by-step configuration, validation and confirmation guides |
| `testing/`      | `TEST-<MM>-<module>.md` manual cases and automated suite maps, grouped by feature     |
| `architecture/` | `ARCH-*` complete architecture, integrations and dataflow                             |
| `requirements/` | `REQ-*` BRD/PRD and product requirements                                              |
| `security/`     | `SEC-*` security review                                                               |
| `status/`       | `STATUS-session-log.md` (newest first) and `STATUS-current.md`                        |
| `audits/`       | `AUD-<date>-<n>-*` engineering audits                                                 |
| `help/`         | Persona manuals and reviewed share exports                                            |
| `reference/`    | Consolidated originals and supporting references                                      |
| `developer/`    | Component guides relocated from the source tree                                       |
| `archive/`      | Superseded stubs kept for traceability                                                |

Naming and placement rules: [`../README.md`](../README.md). Back this folder up
outside Git (encrypted drive or private store); a clone cannot restore it. Never
paste its content into issues, pull requests, chat tools or shared docs.
