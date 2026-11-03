import browser_use_browsers_detect from './browser_use_browsers_detect.js';
import browser_use_browsers_select from './browser_use_browsers_select.js';
import browser_use_browsers_launch_plan from './browser_use_browsers_launch_plan.js';
import browser_use_browsers_attach_validate from './browser_use_browsers_attach_validate.js';
import browser_use_capabilities_matrix from './browser_use_capabilities_matrix.js';
import browser_use_capabilities_check from './browser_use_capabilities_check.js';
import browser_use_capabilities_verified from './browser_use_capabilities_verified.js';
import browser_use_coords_convert from './browser_use_coords_convert.js';
import browser_use_visual_diff from './browser_use_visual_diff.js';
import browser_use_visual_annotate from './browser_use_visual_annotate.js';
import browser_use_state_classify from './browser_use_state_classify.js';
import browser_use_action_preflight from './browser_use_action_preflight.js';
import browser_use_health_diagnose from './browser_use_health_diagnose.js';
import browser_use_session_open from './browser_use_session_open.js';
import browser_use_session_status from './browser_use_session_status.js';
import browser_use_sessions_list from './browser_use_sessions_list.js';
import browser_use_session_close from './browser_use_session_close.js';
import browser_use_snapshot from './browser_use_snapshot.js';
import browser_use_objects from './browser_use_objects.js';
import browser_use_element_check from './browser_use_element_check.js';
import browser_use_act from './browser_use_act.js';
import browser_use_scan from './browser_use_scan.js';
import browser_use_coverage from './browser_use_coverage.js';
import browser_use_screenshot from './browser_use_screenshot.js';
import browser_use_frames from './browser_use_frames.js';
import browser_use_hit_test from './browser_use_hit_test.js';
import browser_use_reveals from './browser_use_reveals.js';
import browser_use_wait from './browser_use_wait.js';
import browser_use_scroll from './browser_use_scroll.js';
import browser_use_navigate from './browser_use_navigate.js';
import browser_use_tabs from './browser_use_tabs.js';
import browser_use_state_read from './browser_use_state_read.js';
import browser_use_region from './browser_use_region.js';
import browser_use_read from './browser_use_read.js';
import browser_use_outline from './browser_use_outline.js';
import browser_use_history from './browser_use_history.js';
import browser_use_resize from './browser_use_resize.js';
import browser_use_evaluate from './browser_use_evaluate.js';
import browser_use_diff_lists from './browser_use_diff_lists.js';
import browser_use_extract from './browser_use_extract.js';
import browser_use_elements from './browser_use_elements.js';
import browser_use_words from './browser_use_words.js';
import browser_use_download from './browser_use_download.js';
import browser_use_upload from './browser_use_upload.js';

/**
 * The `browser_use` pack: the browser intelligence engine as MCP tools.
 *
 * Sixteen answer without a live page — what is installed, what a protocol can do, whether an endpoint is
 * allowed, how a box maps between coordinate spaces, whether two images differ, whether a reveal or an
 * action would be permitted, what is wrong with a page from the read you already have. Twenty-eight run a
 * session: open a page in a browser chosen by capability, keep a world model and a coverage ledger for it,
 * read the whole document band by band, list every element with its coordinates or every word with its box,
 * capture and annotate it down to the last element, cross frames, check whether a stored element is still
 * that element, act with preflight and independent verification, take a file the page offers or hand one
 * over, and close it.
 *
 * Six tools in the pack change anything — `act`, `navigate`, `scroll`, `wait` and `scan` move the page,
 * `download` writes a file, `upload` sends bytes to a site — and the rest are reads. That asymmetry is the
 * point: reading is cheap, acting is a distinct decision with a recorded reason, and success is only claimed
 * when a later read of the page (or the saved bytes) agrees.
 */
export default [
  browser_use_browsers_detect,
  browser_use_browsers_select,
  browser_use_browsers_launch_plan,
  browser_use_browsers_attach_validate,
  browser_use_capabilities_matrix,
  browser_use_capabilities_check,
  browser_use_capabilities_verified,
  browser_use_coords_convert,
  browser_use_visual_diff,
  browser_use_visual_annotate,
  browser_use_state_classify,
  browser_use_action_preflight,
  browser_use_health_diagnose,
  browser_use_session_open,
  browser_use_session_status,
  browser_use_sessions_list,
  browser_use_session_close,
  browser_use_snapshot,
  browser_use_objects,
  browser_use_element_check,
  browser_use_act,
  browser_use_scan,
  browser_use_coverage,
  browser_use_screenshot,
  browser_use_frames,
  browser_use_hit_test,
  browser_use_reveals,
  browser_use_wait,
  browser_use_scroll,
  browser_use_navigate,
  browser_use_tabs,
  browser_use_state_read,
  browser_use_region,
  browser_use_read,
  browser_use_outline,
  browser_use_history,
  browser_use_resize,
  browser_use_evaluate,
  browser_use_diff_lists,
  browser_use_extract,
  browser_use_elements,
  browser_use_words,
  browser_use_download,
  browser_use_upload,
];
