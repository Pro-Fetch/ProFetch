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

/**
 * The `browser_use` pack: the browser intelligence engine's decision layers, exposed as tools.
 *
 * These thirteen answer questions that need no live page — which browsers exist here, what a protocol can
 * actually do, whether an attach endpoint is allowed, how a box maps between coordinate spaces, whether two
 * images differ, whether a reveal is safe, whether an action would be permitted. The session-bound half
 * (snapshot, world model, scan, act) is added on top of them, because a decision layer that cannot be asked
 * a question is a library, not a capability.
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
];
