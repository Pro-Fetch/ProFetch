# MCP-native benchmark

Run: `2026-11-03T09:23:58.077Z` · transport: stdio against `dist/server.js` · profile: `full`

- tools advertised: **713**, of which `browser_use`: **40**
- `tools/list`:   967.1 ms · connect:  3163.0 ms · total call time:  4286.0 ms
- assertions: **21/21 passed**
- live browser tools: **included** (`--live`)

| tool | ms | bytes | assertion |
| --- | ---: | ---: | --- |
| `pro_browser_use_browsers_detect` | 718.6 | 876 | passed |
| `pro_browser_use_diff_lists` | 4.8 | 448 | passed |
| `pro_browser_use_action_preflight` | 3 | 257 | passed |
| `pro_browser_use_browsers_select` | 582.51 | 302 | passed |
| `pro_browser_use_browsers_launch_plan` | 4.18 | 891 | passed |
| `pro_browser_use_browsers_attach_validate` | 3.73 | 305 | passed |
| `pro_browser_use_capabilities_matrix` | 7.75 | 294 | passed |
| `pro_browser_use_capabilities_check` | 3.55 | 802 | passed |
| `pro_browser_use_coords_convert` | 4.19 | 552 | passed |
| `pro_browser_use_state_classify` | 2.69 | 382 | passed |
| `pro_browser_use_health_diagnose` | 4.43 | 2347 | passed |
| `pro_browser_use_session_open` | 2342.72 | 1075 | passed |
| `pro_browser_use_resize` | 243.78 | 477 | passed |
| `pro_browser_use_snapshot` | 16.95 | 3820 | passed |
| `pro_browser_use_element_check` | 2.24 | 493 | passed |
| `pro_browser_use_coverage` | 2.3 | 929 | passed |
| `pro_browser_use_outline` | 2.77 | 344 | passed |
| `pro_browser_use_screenshot` | 68.91 | 64722 | passed |
| `pro_browser_use_extract` | 3.09 | 269 | passed |
| `pro_browser_use_history` | 3.57 | 1150 | passed |
| `pro_browser_use_session_close` | 260.27 | 94 | passed |

The assertion column is the point: a fast wrong answer is a failure. Timings describe this host and
this run; the correctness of each payload is what this harness refuses to publish without.
