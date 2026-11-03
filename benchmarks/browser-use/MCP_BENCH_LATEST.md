# MCP-native benchmark

Run: `2026-11-03T09:49:06.795Z` · transport: stdio against `dist/server.js` · profile: `full`

- tools advertised: **713**, of which `browser_use`: **40**
- `tools/list`:   458.8 ms · connect:  1718.1 ms · total call time:  2863.0 ms
- assertions: **21/21 passed**
- live browser tools: **included** (`--live`)

| tool | ms | bytes | assertion |
| --- | ---: | ---: | --- |
| `pro_browser_use_browsers_detect` | 357.45 | 876 | passed |
| `pro_browser_use_diff_lists` | 3.6 | 448 | passed |
| `pro_browser_use_action_preflight` | 2.15 | 257 | passed |
| `pro_browser_use_browsers_select` | 344.45 | 302 | passed |
| `pro_browser_use_browsers_launch_plan` | 1.65 | 891 | passed |
| `pro_browser_use_browsers_attach_validate` | 1.04 | 305 | passed |
| `pro_browser_use_capabilities_matrix` | 2.76 | 294 | passed |
| `pro_browser_use_capabilities_check` | 2.18 | 802 | passed |
| `pro_browser_use_coords_convert` | 1.85 | 552 | passed |
| `pro_browser_use_state_classify` | 1.54 | 382 | passed |
| `pro_browser_use_health_diagnose` | 2.53 | 2347 | passed |
| `pro_browser_use_session_open` | 1624.54 | 1075 | passed |
| `pro_browser_use_resize` | 174.1 | 477 | passed |
| `pro_browser_use_snapshot` | 13.34 | 3820 | passed |
| `pro_browser_use_element_check` | 1.73 | 493 | passed |
| `pro_browser_use_coverage` | 1.83 | 929 | passed |
| `pro_browser_use_outline` | 1.39 | 344 | passed |
| `pro_browser_use_screenshot` | 39.34 | 64722 | passed |
| `pro_browser_use_extract` | 1.43 | 269 | passed |
| `pro_browser_use_history` | 1.84 | 1150 | passed |
| `pro_browser_use_session_close` | 282.31 | 94 | passed |

The assertion column is the point: a fast wrong answer is a failure. Timings describe this host and
this run; the correctness of each payload is what this harness refuses to publish without.
