---
name: demo-skill
description: C5 夹具技能（全局/user scope），用于验证 getSkills().skills 三类清单里的技能一项
---

# demo-skill

这是 C5 检查脚本的夹具技能，只为证明 `resourceLoader.getSkills().skills` 能被列举并映射成
04 屏的「技能」分组条目。**不产生任何副作用**。

## 什么时候用

仅当 `scripts/c5-resources-models-check.mjs` 把本目录复制进临时 agentDir 的 `skills/` 时。
