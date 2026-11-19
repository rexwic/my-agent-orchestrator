/**
 * Built-in role templates (orch role init <name>). Each role is a plain role
 * definition, validated like a .orchestry/roles/<name>.yml file.
 */

export interface BuiltinRoleTemplate {
  description: string;
  roles: Array<Record<string, unknown>>;
}

export const BUILTIN_ROLE_TEMPLATES: Record<string, BuiltinRoleTemplate> = {};
