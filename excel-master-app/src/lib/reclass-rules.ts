import { GENERATED_RECLASS_RULES } from "./generated-reclass-rules";

export interface ReclassRule {
  rule_id: string;
  category: string;
  sheet_scope: string[];
  reason_zh: string;
  reason_en: string;
}

export const RECLASS_RULES: ReclassRule[] = GENERATED_RECLASS_RULES;
