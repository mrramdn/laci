use crate::{Result, env::Env, files, paths, process};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::LazyLock,
    time::Duration,
};

// Each fixed pattern is compiled once, including matchers used for every task line.
macro_rules! re {
    ($pattern:literal) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).expect("constant regular expression"));
        &*RE
    }};
}
pub fn strip_md(s: &str) -> String {
    let mut out = re!(r"!\[[^\]]*\]\([^)]*\)").replace_all(s, "").into_owned();
    out = re!(r"\[([^\]]+)\]\([^)]*\)").replace_all(&out, "$1").into_owned();
    out = re!(r"<[^>]+>").replace_all(&out, "").into_owned();
    for marker in ["**", "__", "~~", "`"] {
        out = out.replace(marker, "");
    }
    // Single underscores inside identifiers and the ~ in ~/ are ordinary text.
    out = re!(r"(^|\s)[*_]([^*_]+)[*_](\s|$)").replace_all(&out, "$1$2$3").into_owned();
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn section(text: &str, name: &str) -> Option<String> {
    let mut found = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        if found && line.starts_with("# ") {
            break;
        }
        if let Some(title) = line.strip_prefix("## ") {
            if found {
                break;
            }
            found = title.trim().eq_ignore_ascii_case(name);
            continue;
        }
        if found {
            lines.push(line);
        }
    }
    let body = lines.join("\n").trim().to_owned();
    if body.is_empty() { None } else { Some(body) }
}
pub fn parse_meta(text: &str) -> Value {
    let mut meta = json!({});
    let normalized = text.replace("\r\n", "\n");
    if let Some(body) = normalized.strip_prefix("---\n").and_then(|t| t.split_once("\n---").map(|p| p.0)) {
        for line in body.lines() {
            if let Some((key, value)) = line.split_once(':') {
                let value = value.split(" #").next().unwrap_or("").trim().trim_matches(['\'', '"']);
                if value.is_empty() {
                    continue;
                }
                meta[key.trim()] = if value.starts_with('[') && value.ends_with(']') {
                    json!(
                        value[1..value.len() - 1]
                            .split(',')
                            .map(|s| s.trim().trim_matches(['\'', '"']))
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                    )
                } else {
                    json!(value)
                };
            }
        }
    }
    meta
}
pub fn tasks(dir: &Path) -> Value {
    let mut names: Vec<String> = files::entries(dir)
        .into_iter()
        .filter(|e| e.file_type().is_ok_and(|k| k.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|s| re!(r"(?i)^(\.laci|handoff[\w.-]*|todo[\w.-]*|tasks|notes?[\w.-]*|next)\.md$").is_match(s))
        .collect();
    for name in ["tasks/todo.md", "docs/TODO.md", "docs/todo.md"] {
        if dir.join(name).is_file() {
            names.push(name.into());
        }
    }
    let mut result = json!({"meta":{},"tasks":[],"taskFiles":[],"sidecar":false});
    let mut all = Vec::new();
    let mut summaries = Vec::new();
    for name in names {
        let path = dir.join(&name);
        if path.canonicalize().is_ok_and(|p| !p.starts_with(dir.canonicalize().unwrap_or_else(|_| dir.to_owned()))) {
            continue;
        }
        let Some(text) = files::text(&path) else { continue };
        if name == ".laci.md" {
            result["sidecar"] = json!(true);
            result["meta"] = parse_meta(&text);
            if let Some(s) = section(&text, "Notes") {
                result["notes"] = json!(s);
            }
            if let Some(s) = section(&text, "Summary") {
                result["summary"] = json!(strip_md(&s));
            }
        }
        let mut headings: Vec<(usize, String)> = Vec::new();
        let mut todo = 0;
        let mut code = false;
        let mut found = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
                code = !code;
                continue;
            }
            if code {
                continue;
            }
            if let Some(h) = re!(r"^(#{1,6})\s+(.+)").captures(line) {
                let level = h[1].len();
                headings.retain(|(n, _)| *n < level);
                headings.push((level, strip_md(&h[2])));
                if todo > 0 && level <= todo {
                    todo = 0;
                }
                if todo == 0 && re!(r"(?i)\b(todo|to-do|next|pending|open|sisa|belum|lanjut)\b").is_match(&h[2]) {
                    todo = level;
                }
                continue;
            }
            let heading = headings.iter().rev().take(2).rev().map(|(_, s)| s.as_str()).collect::<Vec<_>>().join(" › ");
            if let Some(c) = re!(r"^\s*[-*+]\s+\[([ xX])\]\s+(.+)").captures(line) {
                found.push(json!({"text":strip_md(&c[2]),"done":&c[1]!=" ","kind":"check","file":name,"line":index+1,"section":heading}));
            } else if todo > 0
                && re!(r"(?i)handoff|todo|next").is_match(&name)
                && let Some(c) = re!(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+)").captures(line)
            {
                found.push(json!({"text":strip_md(&c[1]),"done":re!(r"(?i)✅|\bdone\b").is_match(&c[1]),"kind":"list","file":name,"line":index+1,"section":heading}));
            }
        }
        if !found.is_empty() {
            summaries.push(json!({"file":name,"at":files::modified(&path),"open":found.iter().filter(|t|t["done"]==false).count(),"done":found.iter().filter(|t|t["done"]==true).count()}));
        }
        all.extend(found);
    }
    result["tasks"] = json!(all);
    result["taskFiles"] = json!(summaries);
    result
}
fn git(dir: &Path, args: &[&str]) -> String {
    process::run("git", args, Some(dir), Duration::from_secs(20)).unwrap_or_default()
}
fn utc(text: &str) -> String {
    DateTime::parse_from_rfc3339(text)
        .map(|t| t.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub fn git_info(dir: &Path) -> Option<Value> {
    if git(dir, &["rev-parse", "--is-inside-work-tree"]) != "true" {
        return None;
    }
    let root = git(dir, &["rev-parse", "--show-toplevel"]);
    if !dir.join(".git").exists() && Path::new(&root) != dir {
        return None;
    }
    let count = git(dir, &["rev-list", "--count", "HEAD"]).parse::<u64>().unwrap_or(0);
    let last = git(dir, &["log", "-1", "--format=%cI%x1f%s"]);
    let roots = git(dir, &["log", "--max-parents=0", "--format=%H%x1f%cI", "HEAD"]);
    let first = roots.lines().last().unwrap_or("");
    let mut first = first.split('\x1f');
    let mut last = last.split('\x1f');
    let status = git(dir, &["status", "--porcelain=v1", "-b", "--untracked-files=normal"]);
    let head = status.lines().next().unwrap_or("");
    let upstream = head.split("...").nth(1).and_then(|s| s.split_whitespace().next()).unwrap_or("");
    let mut remotes = Vec::new();
    for line in git(dir, &["remote", "-v"]).lines() {
        let cols: Vec<_> = line.split_whitespace().collect();
        if cols.len() < 3 || cols[2] != "(fetch)" {
            continue;
        }
        let url = re!(r"^(https?://)[^@/]+@").replace(cols[1], "$1").into_owned();
        let web = if let Some(ssh) = re!(r"^(?:ssh://)?git@([^:/]+)(?::[0-9]+)?[:/](.+)$").captures(&url) {
            format!("https://{}/{}", &ssh[1], ssh[2].trim_end_matches('/').trim_end_matches(".git"))
        } else if url.starts_with("https://") || url.starts_with("http://") {
            url.trim_end_matches('/').trim_end_matches(".git").into()
        } else {
            String::new()
        };
        let host = web.split('/').nth(2).unwrap_or("");
        remotes.push(json!({"name":cols[0],"url":url,"web":web,"host":host}));
    }
    let tracked = upstream.split('/').next().unwrap_or("");
    remotes.sort_by_key(|r| {
        if r["name"] == tracked {
            0
        } else if r["name"] == "origin" {
            1
        } else {
            2
        }
    });
    let mut weekly = vec![0u64; 26];
    for t in git(dir, &["log", "--since=182.days", "--format=%ct"]).lines() {
        if let Ok(t) = t.parse::<i64>() {
            let week = (Utc::now().timestamp() - t) / 604800;
            if (0..26).contains(&week) {
                weekly[25 - week as usize] += 1;
            }
        }
    }
    let number = |word: &str| {
        Regex::new(&format!(r"{word} (\d+)"))
            .expect("Git count pattern")
            .captures(head)
            .and_then(|c| c[1].parse::<u64>().ok())
            .unwrap_or(0)
    };
    Some(
        json!({"commits":count,"rootCommit":first.next().unwrap_or(""),"firstCommitAt":utc(first.next().unwrap_or("")),
        "lastCommitAt":utc(last.next().unwrap_or("")),"lastSubject":last.next().unwrap_or(""),"branch":git(dir,&["branch","--show-current"]),
        "remotes":remotes,"upstream":upstream,"dirty":status.lines().filter(|l|!l.starts_with("##")&&!l.is_empty()).count(),
        "ahead":number("ahead"),"behind":number("behind"),"stashes":git(dir,&["stash","list"]).lines().count(),"weekly":weekly,
        "authors":git(dir,&["shortlog","-sne","HEAD"]).lines().count(),
        "worktree":dir.join(".git").is_file()}),
    )
}
fn readme(dir: &Path) -> Option<Value> {
    let file = files::entries(dir)
        .into_iter()
        .find(|e| re!(r"(?i)^readme(?:\.(md|markdown|txt|rst))?$").is_match(&e.file_name().to_string_lossy()))?;
    let raw = files::text(&file.path())?;
    let mut title = String::new();
    let mut tagline = String::new();
    let mut sections = Vec::new();
    let mut code = false;
    let mut started = false;
    for line in raw.lines() {
        let s = line.trim();
        if s.starts_with("```") {
            code = !code;
            continue;
        }
        if code {
            continue;
        }
        if let Some(t) = s.strip_prefix("# ") {
            if title.is_empty() {
                title = strip_md(t);
                started = true;
            }
            continue;
        }
        if let Some(t) = s.strip_prefix("## ") {
            sections.push(strip_md(t));
        }
        if tagline.is_empty()
            && (started || title.is_empty())
            && !s.is_empty()
            && !s.starts_with(['#', '!', '[', '<', '|', '-', '*'])
        {
            tagline = strip_md(s).chars().take(280).collect();
        }
    }
    let links: Vec<_> = re!(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
        .captures_iter(&raw)
        .filter(|c| !re!(r"badge|shields|\.(png|svg|jpg)").is_match(&c[2]))
        .take(6)
        .map(|c| json!({"label":strip_md(&c[1]),"url":&c[2]}))
        .collect();
    Some(
        json!({"file":file.file_name().to_string_lossy(),"title":title,"weakTitle":title.len()<3||re!(r"(?i)^(readme|project|app|frontend|backend|docs?)$").is_match(&title),
        "tagline":tagline,"template":re!(r"(?i)create-next-app|this template provides|getting started with create react app|react \+ typescript \+ vite|a new flutter project|astro starter kit").is_match(&raw),
        "links":links,"sections":sections,"images":raw.matches("![").count()+raw.matches("<img").count(),"raw":raw}),
    )
}
fn stack(dir: &Path) -> Value {
    let root: Value =
        files::text(&dir.join("package.json")).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut deps = BTreeSet::new();
    let mut packages = vec![root.clone()];
    for ws in ["apps", "packages"] {
        for e in files::entries(&dir.join(ws)) {
            if !e
                .path()
                .canonicalize()
                .is_ok_and(|p| p.starts_with(dir.canonicalize().unwrap_or_else(|_| dir.to_owned())))
            {
                continue;
            }
            if let Some(p) =
                files::text(&e.path().join("package.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok())
            {
                packages.push(p);
            }
        }
    }
    for p in packages {
        for key in ["dependencies", "devDependencies"] {
            if let Some(map) = p[key].as_object() {
                deps.extend(map.keys().cloned());
            }
        }
    }
    let mut labels = Vec::new();
    for (dep, label) in [
        ("next", "Next.js"),
        ("nuxt", "Nuxt"),
        ("@sveltejs/kit", "SvelteKit"),
        ("astro", "Astro"),
        ("@remix-run/react", "Remix"),
        ("expo", "Expo"),
        ("react-native", "React Native"),
        ("electron", "Electron"),
        ("@tauri-apps/api", "Tauri"),
        ("react", "React"),
        ("vue", "Vue"),
        ("svelte", "Svelte"),
        ("@angular/core", "Angular"),
        ("@nestjs/core", "NestJS"),
        ("express", "Express"),
        ("fastify", "Fastify"),
        ("hono", "Hono"),
        ("elysia", "Elysia"),
        ("prisma", "Prisma"),
        ("@prisma/client", "Prisma"),
        ("drizzle-orm", "Drizzle"),
        ("mongoose", "MongoDB"),
        ("@supabase/supabase-js", "Supabase"),
        ("firebase", "Firebase"),
        ("tailwindcss", "Tailwind"),
        ("@anthropic-ai/sdk", "Claude SDK"),
        ("ai", "AI SDK"),
        ("openai", "OpenAI SDK"),
        ("three", "Three.js"),
        ("motion", "Motion"),
        ("framer-motion", "Motion"),
        ("gsap", "GSAP"),
        ("vite", "Vite"),
        ("vitest", "Vitest"),
        ("jest", "Jest"),
        ("@playwright/test", "Playwright"),
        ("typescript", "TypeScript"),
    ] {
        if deps.contains(dep) && !labels.contains(&label.to_owned()) {
            labels.push(label.to_owned());
        }
    }
    if labels.iter().any(|l| ["Next.js", "Expo", "Remix", "React Native"].contains(&l.as_str())) {
        labels.retain(|l| l != "React");
    }
    for (file, label) in [
        ("Cargo.toml", "Rust"),
        ("go.mod", "Go"),
        ("pyproject.toml", "Python"),
        ("requirements.txt", "Python"),
        ("pubspec.yaml", "Flutter"),
        ("composer.json", "PHP"),
        ("wp-config.php", "WordPress"),
    ] {
        if dir.join(file).exists() && !labels.contains(&label.to_owned()) {
            labels.push(label.to_owned());
        }
    }
    if files::text(&dir.join("composer.json")).is_some_and(|s| s.contains("laravel/framework")) {
        labels.retain(|l| l != "PHP");
        labels.push("Laravel".into());
    }
    let py = files::text(&dir.join("pyproject.toml"))
        .or_else(|| files::text(&dir.join("requirements.txt")))
        .unwrap_or_default()
        .to_lowercase();
    for name in ["django", "fastapi", "flask"] {
        if py.contains(name) {
            labels.push(
                match name {
                    "django" => "Django",
                    "fastapi" => "FastAPI",
                    _ => "Flask",
                }
                .into(),
            );
        }
    }
    let mut languages: BTreeMap<String, u64> = BTreeMap::new();
    let mut newest = String::new();
    let mut count = 0;
    for e in files::walk(dir, false).filter(|e| e.file_type().is_file()).take(10_000) {
        count += 1;
        if e.file_name() != ".laci.md" {
            newest = newest.max(files::modified(e.path()));
        }
        let lang = match e.path().extension().and_then(|e| e.to_str()).unwrap_or("") {
            "ts" | "tsx" | "mts" => "TypeScript",
            "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
            "rs" => "Rust",
            "py" => "Python",
            "go" => "Go",
            "php" => "PHP",
            "dart" => "Dart",
            "vue" => "Vue",
            "svelte" => "Svelte",
            "astro" => "Astro",
            "css" | "scss" => "CSS",
            "html" => "HTML",
            "sh" => "Shell",
            "java" => "Java",
            "kt" => "Kotlin",
            "swift" => "Swift",
            "c" => "C",
            "cpp" => "C++",
            "cs" => "C#",
            "rb" => "Ruby",
            "sql" => "SQL",
            "md" => "Markdown",
            "pdf" | "docx" => "Docs",
            "liquid" => "Liquid",
            _ => "",
        };
        if !lang.is_empty() {
            *languages.entry(lang.into()).or_default() += 1;
        }
        if e.file_name() == "theme.liquid" && !labels.contains(&"Shopify theme".into()) {
            labels.push("Shopify theme".into());
        }
    }
    let mut languages: Vec<_> = languages.into_iter().map(|(name, files)| json!({"name":name,"files":files})).collect();
    languages.sort_by_key(|v| std::cmp::Reverse(v["files"].as_u64().unwrap_or(0)));
    let mut manager = String::new();
    for (file, name) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if dir.join(file).exists() {
            manager = name.into();
            break;
        }
    }
    if manager.is_empty() {
        manager = root["packageManager"].as_str().unwrap_or("").split('@').next().unwrap_or("").into();
    }
    let mut scripts: Vec<_> =
        root["scripts"].as_object().into_iter().flatten().map(|(name, cmd)| json!({"name":name,"cmd":cmd})).collect();
    scripts.sort_by_key(|s| {
        ["dev", "start", "build", "test", "lint", "typecheck", "preview"]
            .iter()
            .position(|name| s["name"] == *name)
            .unwrap_or(99)
    });
    scripts.truncate(8);
    let mut services = BTreeSet::new();
    for file in ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"] {
        if let Some(s) = files::text(&dir.join(file)) {
            for c in re!(r#"(?m)^\s+image:\s*["']?([^\s"':@]+)"#).captures_iter(&s) {
                services.insert(c[1].split('/').next_back().unwrap_or("").to_owned());
            }
            if services.is_empty() {
                for c in re!(r"(?m)^  ([\w.-]+):\s*$").captures_iter(&s) {
                    services.insert(c[1].into());
                }
            }
            labels.push("Docker Compose".into());
            break;
        }
    }
    let env = files::text(&dir.join(".env.example")).unwrap_or_default();
    let env: Vec<_> =
        re!(r"(?m)^\s*([A-Z][A-Z0-9_]+)\s*=").captures_iter(&env).map(|c| c[1].to_owned()).take(40).collect();
    let deploy: Vec<_> = [
        ("vercel.json", "Vercel"),
        ("netlify.toml", "Netlify"),
        ("fly.toml", "Fly.io"),
        ("railway.json", "Railway"),
        ("wrangler.toml", "Cloudflare"),
        ("wrangler.jsonc", "Cloudflare"),
        ("Procfile", "Procfile"),
        ("Dockerfile", "Dockerfile"),
    ]
    .into_iter()
    .filter(|(f, _)| dir.join(f).exists())
    .map(|(_, l)| l)
    .collect();
    let mut ci = Vec::new();
    if dir.join(".github/workflows").is_dir() {
        ci.push("GitHub Actions");
    }
    if dir.join(".gitlab-ci.yml").is_file() {
        ci.push("GitLab CI");
    }
    json!({"labels":labels,"languages":languages,"packageManager":manager,"scripts":scripts,"services":services,"env":env,"deploy":deploy,"ci":ci,"description":root["description"],"newest":newest,"files":count})
}
/// Groups read only their own documents; traversing all children here would duplicate every project scan.
pub fn folder(env: &Env, dir: &Path) -> Result<Value> {
    let path = paths::workspace_path(&dir.to_string_lossy(), env)?;
    let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let t = tasks(dir);
    let r = readme(dir);
    let archived = dir.components().any(|c| re!(r"(?i)^_?archived?s?$").is_match(&c.as_os_str().to_string_lossy()));
    let mut n = json!({"id":path,"path":path,"name":name,"label":name,"kind":"folder","children":[],"archived":archived,"stableId":"","meta":t["meta"],"status":{"value":t["meta"]["status"].as_str().unwrap_or(if archived{"archived"}else{"dormant"}),"auto":t["meta"]["status"].is_null()},"tasks":t["tasks"],"taskFiles":t["taskFiles"],"sidecar":t["sidecar"],"agents":{"claude":[],"items":[],"aiFiles":ai_files(dir)},"issues":[]});
    if let Some(r) = r {
        n["readme"] = r;
    }
    if let Some(notes) = t["notes"].as_str() {
        n["notes"] = json!(notes);
    }
    if let Some(summary) = t["summary"].as_str().filter(|s| !s.is_empty()) {
        n["summary"] = json!({"text":summary,"source":".laci.md"});
    } else if n["readme"]["template"] != true
        && let Some(summary) = n["readme"]["tagline"].as_str().filter(|s| !s.is_empty())
    {
        n["summary"] = json!({"text":summary,"source":n["readme"]["file"]});
    }
    if let Ok(created) = std::fs::metadata(dir).and_then(|m| m.created()) {
        n["createdAt"] = json!({"at":DateTime::<Utc>::from(created).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":"folder"});
    }
    Ok(n)
}

fn ai_files(dir: &Path) -> Vec<&'static str> {
    [
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        ".claude",
        ".cursor",
        ".cursorrules",
        ".windsurf",
        ".serena",
        ".mcp.json",
        ".codex",
        ".aider.conf.yml",
        ".github/copilot-instructions.md",
    ]
    .into_iter()
    .filter(|f| dir.join(f).exists())
    .collect()
}

pub fn project(env: &Env, dir: &Path) -> Result<Value> {
    let path = paths::workspace_path(&dir.to_string_lossy(), env)?;
    let path = path.to_string_lossy().into_owned();
    let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let tasks = tasks(dir);
    let stack = stack(dir);
    let git = git_info(dir);
    let readme = readme(dir);
    let code = git.is_some()
        || [
            "package.json",
            "Cargo.toml",
            "go.mod",
            "pyproject.toml",
            "requirements.txt",
            "composer.json",
            "pubspec.yaml",
            "pom.xml",
            "build.gradle",
            "Makefile",
            "CMakeLists.txt",
        ]
        .iter()
        .any(|f| dir.join(f).exists());
    let archived = dir.components().any(|c| re!(r"(?i)^_?archived?s?$").is_match(&c.as_os_str().to_string_lossy()));
    let newest =
        stack["newest"].as_str().unwrap_or("").max(git.as_ref().and_then(|g| g["lastCommitAt"].as_str()).unwrap_or(""));
    let activity_source =
        if git.as_ref().and_then(|g| g["lastCommitAt"].as_str()).is_some_and(|at| !at.is_empty() && at == newest) {
            "commit"
        } else {
            "files"
        };
    let status = tasks["meta"]["status"].as_str().unwrap_or(if archived {
        "archived"
    } else if files::age(newest) <= 14.0 {
        "active"
    } else if files::age(newest) <= 60.0 {
        "idle"
    } else {
        "dormant"
    });
    let mut node = json!({"id":path,"path":path,"name":name,"label":name,"kind":"project","type":if code{"code"}else{"docs"},"children":[],"archived":archived,
        "stableId":git.as_ref().and_then(|g|g["rootCommit"].as_str()).unwrap_or(&path),"meta":tasks["meta"],"status":{"value":status,"auto":tasks["meta"]["status"].is_null()},
        "tasks":tasks["tasks"],"taskFiles":tasks["taskFiles"],"sidecar":tasks["sidecar"],"agents":{"claude":[],"items":[],"aiFiles":[]},"issues":[],"stack":stack,
        "ownActivity":{"at":newest,"source":activity_source},"lastActivity":{"at":newest,"source":activity_source}});
    if let Ok(created) = std::fs::metadata(dir).and_then(|m| m.created()) {
        node["createdAt"] = json!({"at":DateTime::<Utc>::from(created).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":"folder"});
    }
    if let Some(g) = git {
        if let Some(first) = g["firstCommitAt"].as_str().filter(|s| !s.is_empty()) {
            node["createdAt"] = json!({"at":first,"source":"first commit"});
        }
        node["git"] = g;
    }
    if let Some(r) = readme {
        node["readme"] = r;
    }
    if let Some(notes) = tasks["notes"].as_str() {
        node["notes"] = json!(notes);
    }
    let summary = tasks["summary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| (s, ".laci.md"))
        .or_else(|| {
            if node["readme"]["template"] == true {
                None
            } else {
                node["readme"]["tagline"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| (s, node["readme"]["file"].as_str().unwrap_or("README")))
            }
        })
        .or_else(|| node["stack"]["description"].as_str().filter(|s| !s.is_empty()).map(|s| (s, "package.json")));
    if let Some((text, source)) = summary {
        let summary = json!({"text":text,"source":source});
        node["summary"] = summary;
    }
    node["agents"]["aiFiles"] = json!(ai_files(dir));
    fn heavy(root: &Path, dir: &Path, depth: usize, parts: &mut Vec<Value>) {
        for e in files::entries(dir).into_iter().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
            let name = e.file_name().to_string_lossy().into_owned();
            if files::HEAVY.contains(&name.as_str()) {
                let bytes = files::size(&e.path());
                if bytes > 1_000_000 {
                    parts.push(json!({"path":e.path().strip_prefix(root).unwrap_or(&e.path()),"bytes":bytes}));
                }
            } else if depth < 3 && !name.starts_with('.') {
                heavy(root, &e.path(), depth + 1, parts);
            }
        }
    }
    let mut parts = Vec::new();
    heavy(dir, dir, 0, &mut parts);
    parts.sort_by_key(|p| std::cmp::Reverse(p["bytes"].as_u64().unwrap_or(0)));
    let reclaimable = parts.iter().map(|p| p["bytes"].as_u64().unwrap_or(0)).sum::<u64>();
    parts.truncate(4);
    node["size"] = json!({"total":files::size(dir),"reclaimable":reclaimable,"parts":parts});
    Ok(node)
}
