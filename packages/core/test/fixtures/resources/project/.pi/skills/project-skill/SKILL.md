---
name: project-skill
description: C5 夹具技能（项目本地/project scope），用于验证未信任时项目本地技能也被过滤
---

# project-skill

项目本地技能夹具：`<cwd>/.pi/skills/` 下的技能 `scope === "project"`，
与项目本地扩展同受信任门管辖（未信任时 `/resources.skills` 里不应出现它）。
