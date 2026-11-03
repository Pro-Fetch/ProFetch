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

/**
 * The `browser_use` pack: the browser intelligence engine as MCP tools.
 *
 * Thirteen of these answer questions with no live page — what is installed, what a protocol can do, whether
 * an endpoint is allowed, how a box maps between coordinate spaces, whether two images differ, whether a
 * reveal or an action would be permitted, what is wrong with a page from the read you already have. Eight
 * more run a session: open a page in a chosen browser, keep a world model and coverage ledger for it, read
 * it again to see the delta, group it into objects, check whether a stored element is still the same
 * element, act with preflight and verification, and close it.
 *
 * One tool in the pack changes anything (`pro_browser_use_act`), and it is the one that refuses most
 * often. That asymmetry is deliberate: a surface where reading is cheap and acting is a distinct,
 * explained decision is the shape that keeps a model from reporting success it never checked.
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
];
