/**
 * A schema inferred from a sample describes that sample; it must not forbid the rest of the API.
 *
 * Measured from a host driving the workflow: it inferred a schema from one GitHub repository object,
 * validated a second real object against it, and got ten rejections - all of them fields the first
 * response happened not to carry. `additionalProperties: false` is the right rule for a *tool input*
 * contract, where the author lists every accepted key; applied to inference it turns a sample into a
 * cage.
 */

import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';

const text = (result: { content?: Array<{ type: string; text?: string }> }) =>
  (result.content ?? []).map((item) => item.text ?? '').join('');

const payload = (result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> => {
  const raw = text(result);
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
};

const first = {
  name: 'repo-a',
  forks_url: 'https://api.github.com/repos/a/forks',
  open_issues: 3,
  owner: { login: 'a', avatar_url: 'https://avatars/1' },
};

// A sibling response from the same endpoint: same shape, extra fields the sample never showed.
const second = {
  name: 'repo-b',
  forks_url: 'https://api.github.com/repos/b/forks',
  open_issues: 9,
  owner: { login: 'b', avatar_url: 'https://avatars/2', user_view_type: 'public' },
  default_workflow_permissions: 'read',
  visibility: 'public',
};

describe('pro_fetch_json_schema_infer', () => {
  it('observes the sample without closing the object against it', async () => {
    const inferred = payload(await dispatch('pro_fetch_json_schema_infer', { json: JSON.stringify(first) }));
    const schema = (inferred.schema ?? inferred) as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['name', 'forks_url', 'open_issues', 'owner']);
    expect(schema.additionalProperties).toBe(true);
  });

  it('validates another real response from the same endpoint', async () => {
    const inferred = payload(await dispatch('pro_fetch_json_schema_infer', { json: JSON.stringify(first) }));
    const schema = (inferred.schema ?? inferred) as Record<string, unknown>;
    const checked = await dispatch('pro_schema_validate', {
      schema: JSON.stringify(schema),
      value: JSON.stringify(second),
    });
    expect(checked.isError, text(checked)).not.toBe(true);
    expect(text(checked)).not.toMatch(/additional properties|default_workflow_permissions/i);
  });

  it('still reports a genuinely wrong type', async () => {
    const inferred = payload(await dispatch('pro_fetch_json_schema_infer', { json: JSON.stringify(first) }));
    const schema = (inferred.schema ?? inferred) as Record<string, unknown>;
    const broken = await dispatch('pro_schema_validate', {
      schema: JSON.stringify(schema),
      value: JSON.stringify({ ...second, open_issues: 'many' }),
    });
    expect(text(broken)).toMatch(/integer|type/i);
  });
});
