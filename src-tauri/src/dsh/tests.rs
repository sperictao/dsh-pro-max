//! dsh 域单元测试（原 dsh.rs tests 模块整体平移，导入清单未改）。

    use super::auth::{AuthConfig, parse_extra_logins, rpc_request, serve_status_targets_web, tailscale_login_from_status_json, validate_cap_domain};
    use super::autostart::{port_guard_js, render_desktop_entry, render_start_web, sh_quote};
    use super::components::{dsh_version_is_compatible, normalize_version, plugin_profile_is_current, version_within_supported_line};
    use crate::version::parse_version;
    use super::{RemoteRpcAccess, RemoteUrlAccess, SUPPORTED_DSH_VERSION};
    use super::probe::{classify_remote_rpc_response, classify_remote_url_access, curl_direct_args, curl_remote_rpc_args, parse_macos_https_proxy, proxy_bypass_host, proxy_bypasses_host, REMOTE_WS_PATH};
    use super::process::{dsh_web_cmd_pattern, ere_to_ps_wildcards, run_capture, which, win_cmd_line, win_quote};
    use super::setup::{format_verification_checks, serve_command, serve_failure_solution, start_failure_diagnosis};
    use super::update::{WEB_PROFILE_COMPAT_ID_LINE, insert_web_profile_compat_entry, remove_web_profile_compat_entry, rewrite_web_profile_patch_at};
    use crate::i18n::set_current;
    use std::path::Path;

    #[test]
    fn dsh_web_pattern_matches_all_command_shapes() {
        // 回归（v1.5.0）：一键启动后点停止无效。dsh_stop / dsh_web_pid 按
        // 命令行特征匹配进程，而 spawn_dsh_web 实际拉起的是
        // `dsh --profile web --host 127.0.0.1 --port 3899`——`--host 127.0.0.1`
        // 插在 profile web 与 --port 3899 之间，旧连写模式永远命不中。
        // 断言 dsh_web_cmd_pattern() 能覆盖三条真实路径的命令形态
        let pattern = dsh_web_cmd_pattern();
        assert!(
            pattern.contains("profile web.*--port 3899"),
            "直启命令 `dsh --profile web --host 127.0.0.1 --port 3899` 必须能命中"
        );
        assert!(
            pattern.contains("--port 3899.*profile web"),
            "历史 npm 包布局 `...index.js --profile web --port 3899` 必须能命中"
        );
    }

    #[test]
    fn ps_wildcards_translate_ere_for_windows() {
        // Windows 的进程匹配走 PowerShell -like 通配，把 ERE 的两个分支翻成
        // 两个通配串，避免 -like 把 `|`/`.*` 当字面量导致同样命不中
        let wildcards = ere_to_ps_wildcards(dsh_web_cmd_pattern());
        assert_eq!(
            wildcards,
            vec![
                "*profile web*--port 3899*",
                "*--port 3899*profile web*",
            ]
        );
        assert_eq!(
            ere_to_ps_wildcards("loopback-proxy.js"),
            vec!["*loopback-proxy.js*"]
        );
    }

    #[test]
    fn validate_cap_domain_accepts_and_rejects() {
        assert_eq!(validate_cap_domain("example.com").unwrap(), "example.com");
        assert_eq!(validate_cap_domain("  sub.example.com  ").unwrap(), "sub.example.com");
        assert!(validate_cap_domain("").is_err());
        assert!(validate_cap_domain("example").is_err());
        assert!(validate_cap_domain("-example.com").is_err());
        assert!(validate_cap_domain("example.com.").is_err());
        assert!(validate_cap_domain("example .com").is_err());
        assert!(validate_cap_domain("example/com").is_err());
    }

    #[test]
    fn parse_extra_logins_splits_trims_dedups() {
        assert_eq!(
            parse_extra_logins("alice@example.com, bob@example.com ,alice@example.com").unwrap(),
            vec!["alice@example.com".to_string(), "bob@example.com".to_string()]
        );
        assert_eq!(parse_extra_logins("").unwrap(), Vec::<String>::new());
        assert_eq!(parse_extra_logins(" , ").unwrap(), Vec::<String>::new());
        // 逗号是分隔符，两段各自是合法登录名；真正非法的是白名单之外的字符
        assert!(parse_extra_logins("bad login@example.com").is_err());
        assert!(parse_extra_logins("bad%PATH%@example.com").is_err());
    }

    #[test]
    fn sh_quote_handles_spaces_and_quotes() {
        assert_eq!(sh_quote("/Users/a b/node"), "'/Users/a b/node'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("/usr/local/bin/node"), "'/usr/local/bin/node'");
    }

    #[test]
    fn start_scripts_embed_guard_and_exec() {
        let auth = AuthConfig {
            extra_allowed_logins: Vec::new(),
            use_capability: None,
            admin_capability: Some("example.com/cap/dsh-admin".to_string()),
        };
        let web = render_start_web(
            "/usr/local/bin/node",
            "/home/u/.npm-global/bin/dsh",
            "etmacmini.ts.net",
            "owner@example.com",
            &auth,
        );
        assert!(web.contains("net.connect(3899"));
        assert!(web.contains("export DSH_TAILSCALE_ALLOWED_LOGINS='owner@example.com'"));
        assert!(web.contains("export DSH_TAILSCALE_ADMIN_CAPABILITY='example.com/cap/dsh-admin'"));
        assert!(web.contains("--trusted-host 'etmacmini.ts.net'"));
        assert!(web.contains(
            "exec '/home/u/.npm-global/bin/dsh' --profile web --host 127.0.0.1 --port 3899 --no-open"
        ));
        // npm shim 的 #!/usr/bin/env node 依赖 PATH：launchd/systemd 裸 PATH
        // 下必须显式补 node 所在目录，否则开机自启以 127 秒退
        assert!(web.contains("export PATH='/usr/local/bin':$PATH"));
        assert!(!web.contains("SSH_CONNECTION"));
        assert!(!web.contains("3898"));
    }

    #[test]
    fn auth_plugin_profile_requires_pinned_specs_and_bundle_entries() {
        let current = r#"{
          "dependencies": {
            "@dsh-external/dsh-client-connection-authz": "file:/opt/dsh-plugins/connection.tgz",
            "@dsh-external/dsh-auth-tailscale": "file:/opt/dsh-plugins/tailscale.tgz"
          },
          "dsh": { "profile": { "bundles": [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@dsh-external/dsh-auth-tailscale",
            "@dsh-external/dsh-client-connection-authz"
          ] } }
        }"#;
        assert!(plugin_profile_is_current(
            current,
            "file:/opt/dsh-plugins/connection.tgz",
            "file:/opt/dsh-plugins/tailscale.tgz",
        ));

        let stale = current.replace("connection.tgz", "connection-old.tgz");
        assert!(!plugin_profile_is_current(
            &stale,
            "file:/opt/dsh-plugins/connection.tgz",
            "file:/opt/dsh-plugins/tailscale.tgz",
        ));
        let missing_bundle = current.replace(
            ",\n            \"@dsh-external/dsh-client-connection-authz\"",
            "",
        );
        assert!(!plugin_profile_is_current(
            &missing_bundle,
            "file:/opt/dsh-plugins/connection.tgz",
            "file:/opt/dsh-plugins/tailscale.tgz",
        ));
    }

    #[test]
    fn dsh_version_compatible_pins_to_supported_line() {
        // 闸门唯一事实来源是 SUPPORTED_DSH_VERSION 常量（不再读 profile 里
        // 已装插件的 peer——那会在「CLI 已升、插件未升」的跟线窗口里自相
        // 矛盾）。常量自身和同线更高 rc/稳定版兼容。
        assert!(dsh_version_is_compatible(Some(SUPPORTED_DSH_VERSION)));
        assert!(dsh_version_is_compatible(Some("0.1.2-alpha.3")));
        assert!(dsh_version_is_compatible(Some("0.1.2")));
        // 跨线一律不兼容：旧线 0.1.1/0.1.0 与更远的线都拒绝。0.1.0-rc.8 曾满足
        // ">= 下限"的宽松判定，但跨线重排了运行时与数据格式（实机教训）
        assert!(!dsh_version_is_compatible(Some("0.1.1-rc.2")));
        assert!(!dsh_version_is_compatible(Some("0.1.0-rc.8")));
        assert!(!dsh_version_is_compatible(Some("1.0.0")));
        // 低于锁定版本或无法解析的版本不兼容
        assert!(!dsh_version_is_compatible(Some("0.1.2-alpha.1")));
        assert!(!dsh_version_is_compatible(Some("0.0.1-rc.5")));
        assert!(!dsh_version_is_compatible(Some("not-a-version")));
        assert!(!dsh_version_is_compatible(None));
    }

    #[test]
    fn verification_checks_are_separated_for_readability() {
        let checks = vec![
            "dsh web is not responding on 127.0.0.1:3899".to_string(),
            "HTTPS endpoint is not responding: https://example.ts.net".to_string(),
            "WebSocket handshake failed: https://example.ts.net/api/remote.mux".to_string(),
        ];
        assert_eq!(
            format_verification_checks(&checks),
            "dsh web is not responding on 127.0.0.1:3899\nHTTPS endpoint is not responding: https://example.ts.net\nWebSocket handshake failed: https://example.ts.net/api/remote.mux",
        );
    }

    #[test]
    fn version_gate_requires_same_minor_line() {
        let min = parse_version("0.1.0-rc.8").unwrap();
        let gate = |v: &str| version_within_supported_line(&parse_version(v).unwrap(), &min);
        assert!(gate("0.1.0-rc.8"));
        assert!(gate("0.1.0-rc.9"));
        assert!(gate("0.1.0"));
        assert!(!gate("0.1.0-rc.7"));
        assert!(!gate("0.1.1-rc.2"));
        assert!(!gate("0.2.0"));
        assert!(!gate("1.0.0"));
    }

    #[test]
    fn web_profile_compat_entry_replaces_commented_empty_array() {
        let header = "# Your patch layer for this dsh profile\n# applied after every bundle layer\n";
        let empty = format!("{header}[]\n");
        let expected = format!("{header}- id: dsh-pro-max-compat\n  name: '@deepseek-ai/dsh-attachment'\n  config: {{}}\n  # Launcher managed: installed dsh CLI is 0.1.1-rc.2\n");
        let inserted = insert_web_profile_compat_entry(&empty, "0.1.1-rc.2");
        assert_eq!(inserted, expected);
        assert_eq!(
            insert_web_profile_compat_entry(&inserted, "0.1.1-rc.2"),
            inserted
        );
        let upgraded_comment = insert_web_profile_compat_entry(&inserted, "0.1.1-rc.3");
        assert!(upgraded_comment.contains("installed dsh CLI is 0.1.1-rc.3"));
        assert!(!upgraded_comment.contains("installed dsh CLI is 0.1.1-rc.2"));
        let invalid_old_output = format!("{empty}{}", inserted.strip_prefix(header).unwrap());
        assert_eq!(
            insert_web_profile_compat_entry(&invalid_old_output, "0.1.1-rc.2"),
            inserted
        );
        let multi_document = format!("{invalid_old_output}---\n[]\n");
        assert_eq!(
            insert_web_profile_compat_entry(&multi_document, "0.1.1-rc.2"),
            format!("{inserted}---\n[]\n")
        );
        assert_eq!(remove_web_profile_compat_entry(&inserted), empty);
    }

    #[test]
    fn start_diagnosis_points_rewritten_credentials_at_migration() {
        // 装过跨线 dsh 的机器降回锁定线后 boot 崩在 credentials 新格式，
        // 诊断必须把用户指向手动还原而不是通用的「看日志」
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pro-max-diag-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("dsh-web.log");
        std::fs::write(
            &log,
            "Error: credentials-local: the value for \"version\" in /Users/x/.dsh/.credentials.yaml must be a string\n",
        )
        .unwrap();
        let (_, solution) = start_failure_diagnosis(&log);
        assert!(solution.contains(".credentials.yaml"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_access_url_parses_the_last_native_token_line() {
        // 本地访问遵循 dsh 原生方式：多次启动追加日志，取最后一次带 token 的地址
        let log = concat!(
            "dsh web: http://127.0.0.1:3899/?token=Old123\n",
            "dsh web: http://127.0.0.1:3899\n",
            "Node.js v26.0.0\n",
            "dsh web: http://127.0.0.1:3899/?token=New456\n",
        );
        assert_eq!(
            super::start::local_access_url_from_log_contents(log).as_deref(),
            Some("http://127.0.0.1:3899/?token=New456")
        );
        // 授权插件在场时 dsh 打印裸地址，无 token 行则不返回
        assert_eq!(
            super::start::local_access_url_from_log_contents("dsh web: http://127.0.0.1:3899\n"),
            None
        );
        assert_eq!(super::start::local_access_url_from_log_contents(""), None);
    }

    #[test]
    fn local_access_url_scopes_parsing_to_the_current_boot_region() {
        // 重启场景：旧实例的 token 行留在只追加的日志里，解析必须只看本次
        // 启动之后追加的区域，否则会把死 token 交给浏览器（401）
        let prior = "dsh web: http://127.0.0.1:3899/?token=Old123\n";
        let offset = prior.len();
        // 本次启动尚未打印 token 行：新区域为空，绝不能返回旧实例的 token
        assert_eq!(
            super::start::local_access_url_from_log_contents(super::start::fresh_log_region(prior, offset)),
            None
        );
        // 本次启动打印后：只认新区域里的 token
        let log = format!(
            "{prior}dsh web: http://127.0.0.1:3899\nNode.js v26.0.0\ndsh web: http://127.0.0.1:3899/?token=New456\n"
        );
        assert_eq!(
            super::start::local_access_url_from_log_contents(super::start::fresh_log_region(&log, offset)).as_deref(),
            Some("http://127.0.0.1:3899/?token=New456")
        );
        // 锚点越界（日志被清空/轮转）按空区域处理，等待超时后走裸地址回退
        assert_eq!(super::start::fresh_log_region(prior, 9999), "");
        // 锚点落在多字节字符中间（日志被替换为不同内容）回退整份日志，不 panic
        let multibyte = "dsh web: 中文\n";
        let mid_char = "dsh web: ".len() + 1;
        assert_eq!(super::start::fresh_log_region(multibyte, mid_char), multibyte);
    }

    #[test]
    fn plugin_add_postcondition_recreates_the_compat_patch() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pro-max-compat-{}-{unique}",
            std::process::id()
        ));
        let patch = dir.join("cordis.patch.yml");

        rewrite_web_profile_patch_at(&patch, "0.1.1-rc.2").unwrap();

        let contents = std::fs::read_to_string(&patch).unwrap();
        assert!(contents.contains(WEB_PROFILE_COMPAT_ID_LINE));
        assert!(contents.contains("installed dsh CLI is 0.1.1-rc.2"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn web_profile_compat_removal_preserves_other_entries() {
        let contents = "# profile patch\n- id: existing\n  name: existing-plugin\n  config: {}\n- id: dsh-pro-max-compat\n  name: '@deepseek-ai/dsh-attachment'\n  config: {}\n  # Launcher managed: installed dsh CLI is 0.1.1-rc.2\n- id: following\n  name: following-plugin\n  config: {}\n";
        let expected = "# profile patch\n- id: existing\n  name: existing-plugin\n  config: {}\n- id: following\n  name: following-plugin\n  config: {}\n";
        assert_eq!(remove_web_profile_compat_entry(contents), expected);
        assert_eq!(remove_web_profile_compat_entry(expected), expected);
    }

    #[test]
    fn tailscale_login_maps_self_user_id_exactly() {
        let status = r#"{
          "Self": { "UserID": 42 },
          "User": {
            "7": { "LoginName": "other@example.com" },
            "42": { "LoginName": "owner@example.com" }
          }
        }"#;
        assert_eq!(
            tailscale_login_from_status_json(status).unwrap(),
            "owner@example.com"
        );

        // 新形态：User 表的 key 与条目 ID 字段不一致，Self.UserID 匹配
        // 条目 ID（实测 Tailscale 客户端演进后的 status 输出）。按表 key
        // 查找会落空 → 一键启动在身份步骤失败、spawn 静默降级到
        // local-only allowlist，远程访问整体 403 而「本地正常」
        let drifted = r#"{
          "Self": { "UserID": 70594654120136504 },
          "User": {
            "70594654120136503": {
              "ID": 70594654120136504,
              "LoginName": "owner@example.com"
            }
          }
        }"#;
        assert_eq!(
            tailscale_login_from_status_json(drifted).unwrap(),
            "owner@example.com"
        );

        let malformed = r#"{"Self":{"UserID":42},"User":{"42":{"LoginName":"bad,login"}}}"#;
        assert!(tailscale_login_from_status_json(malformed).is_err());
        let cmd_expansion =
            r#"{"Self":{"UserID":42},"User":{"42":{"LoginName":"bad%PATH%@example.com"}}}"#;
        assert!(tailscale_login_from_status_json(cmd_expansion).is_err());
        assert!(tailscale_login_from_status_json("{}").is_err());
    }

    #[test]
    fn serve_command_forwards_configured_capabilities() {
        // 只转发非空的 capability：0/1/2 三种形态。漏传 --accept-app-caps 时，
        // 即使 dsh 端注入了对应 env 也拿不到能力头，远程设置会退化成恒定 403
        let none = AuthConfig::default();
        assert_eq!(
            serve_command(&none),
            vec!["serve".to_string(), "--https=443".to_string(), "--bg".to_string(), "3899".to_string()]
        );
        let admin_only = AuthConfig {
            extra_allowed_logins: Vec::new(),
            use_capability: None,
            admin_capability: Some("example.com/cap/dsh-admin".to_string()),
        };
        assert_eq!(
            serve_command(&admin_only),
            vec![
                "serve".to_string(), "--https=443".to_string(), "--bg".to_string(),
                "--accept-app-caps=example.com/cap/dsh-admin".to_string(), "3899".to_string(),
            ]
        );
        let both = AuthConfig {
            extra_allowed_logins: Vec::new(),
            use_capability: Some("example.com/cap/dsh".to_string()),
            admin_capability: Some("example.com/cap/dsh-admin".to_string()),
        };
        assert_eq!(
            serve_command(&both),
            vec![
                "serve".to_string(), "--https=443".to_string(), "--bg".to_string(),
                "--accept-app-caps=example.com/cap/dsh,example.com/cap/dsh-admin".to_string(),
                "3899".to_string(),
            ]
        );
    }

    #[test]
    fn serve_status_matches_only_the_dsh_web_target() {
        let ready = "https://node.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3899";
        assert!(serve_status_targets_web(ready));
        assert!(!serve_status_targets_web(
            "https://node.example.ts.net\n|-- / proxy http://127.0.0.1:13899",
        ));
        assert!(!serve_status_targets_web("No serve config"));
    }

    #[test]
    fn auth_start_script_binds_loopback_and_exports_allowlist() {
        let auth = AuthConfig {
            extra_allowed_logins: vec!["alice@example.com".to_string()],
            use_capability: None,
            admin_capability: Some("example.com/cap/dsh-admin".to_string()),
        };
        let web = render_start_web(
            "/usr/local/bin/node",
            "/home/u/.npm-global/bin/dsh",
            "node.tailnet.ts.net",
            "owner@example.com",
            &auth,
        );
        assert!(web.contains("export DSH_TAILSCALE_ALLOWED_LOGINS='owner@example.com,alice@example.com'"));
        assert!(web.contains("export DSH_TAILSCALE_ADMIN_CAPABILITY='example.com/cap/dsh-admin'"));
        assert!(web.contains("--host 127.0.0.1 --port 3899"));
        assert!(web.contains("--trusted-host 'node.tailnet.ts.net'"));
        assert!(!web.contains("SSH_CONNECTION"));
        assert!(!web.contains("3898"));
    }

    #[test]
    fn guard_js_targets_loopback() {
        assert!(port_guard_js(3899).contains("net.connect(3899,'127.0.0.1')"));
    }

    #[test]
    fn parse_dist_tags_filters_non_semver_and_keeps_order() {
        use super::update::parse_dist_tags;
        let tags = parse_dist_tags(r#"{"latest":"0.1.0-rc.7","next":"0.1.0-rc.8","junk":"not-a-version"}"#).unwrap();
        assert_eq!(
            tags,
            vec![
                ("latest".to_string(), "0.1.0-rc.7".to_string()),
                ("next".to_string(), "0.1.0-rc.8".to_string()),
            ]
        );
        // 非 JSON / 空对象
        assert!(parse_dist_tags("not json").is_err());
        assert_eq!(parse_dist_tags("{}").unwrap(), Vec::<(String, String)>::new());
        // Windows 回归：cmd /c 包装的 npm 输出带 UTF-8 BOM / 首尾换行
        assert_eq!(
            parse_dist_tags("\u{feff}\r\n{\"latest\":\"0.1.0-rc.7\"}\r\n").unwrap(),
            vec![("latest".to_string(), "0.1.0-rc.7".to_string())]
        );
        // Windows 回归（v0.3.1 实机）：部分 npm/shim 的 --json 输出是数组包对象。
        // 数组形态的对象 key 顺序经 serde Map 重排，按无序集合断言
        let mut arr_tags = parse_dist_tags("[\n  {\n    \"next\": \"0.1.0-rc.8\",\n    \"latest\": \"0.1.0-rc.7\"\n  }\n]").unwrap();
        arr_tags.sort();
        assert_eq!(
            arr_tags,
            vec![
                ("latest".to_string(), "0.1.0-rc.7".to_string()),
                ("next".to_string(), "0.1.0-rc.8".to_string()),
            ]
        );
        // 数组多元素 / 数组包非对象 → 解析失败
        assert!(parse_dist_tags("[{},{}]").is_err());
        assert!(parse_dist_tags("[\"x\"]").is_err());
    }

    #[test]
    fn desktop_entry_quotes_script_path() {
        // XDG autostart 的 Exec 由桌面环境按 GLib 规则解析：单引号引路径
        assert_eq!(
            render_desktop_entry("DeepSeek Harness web (remote access)", Path::new("/home/u/.dsh/start-web.sh")),
            "[Desktop Entry]\nType=Application\nName=DeepSeek Harness web (remote access)\nComment=DeepSeek Harness remote access via Tailscale\nExec=/bin/sh '/home/u/.dsh/start-web.sh'\nTerminal=false\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
        );
        // 带空格路径也能被单引号包住
        assert!(
            render_desktop_entry("x", Path::new("/home/u a/.dsh/start-web.sh"))
                .contains("Exec=/bin/sh '/home/u a/.dsh/start-web.sh'")
        );
    }

    #[test]
    fn win_quote_keeps_backslashes_literal() {
        // 反斜杠是字面量：不能翻倍
        assert_eq!(win_quote(r"C:\Program Files\nodejs\node.exe"), "\"C:\\Program Files\\nodejs\\node.exe\"");
        assert_eq!(win_quote(r"C:\Windows\System32\cmd.exe"), r"C:\Windows\System32\cmd.exe");
        assert_eq!(win_quote("status"), "status");
        assert_eq!(win_quote("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn win_cmd_line_outer_wraps_for_cmd_slash_c() {
        // cmd /c 会剥掉首尾引号，所以整体必须再包一层
        assert_eq!(
            win_cmd_line(r"C:\Program Files\Tailscale\tailscale.exe", &["status"]),
            "\"\"C:\\Program Files\\Tailscale\\tailscale.exe\" status\""
        );
        assert_eq!(
            win_cmd_line("npm", &["install", "-g", "@deepseek-ai/dsh"]),
            "\"npm install -g @deepseek-ai/dsh\""
        );
        assert_eq!(
            win_cmd_line(r"C:\Users\a b\dsh-plugins\auth.tgz", &[]),
            "\"\"C:\\Users\\a b\\dsh-plugins\\auth.tgz\"\""
        );
    }

    #[test]
    fn normalize_version_extracts_parseable_core() {
        // dsh 实测输出（无 v 前缀）
        assert_eq!(normalize_version("0.1.0-rc.6"), "0.1.0-rc.6");
        // v 前缀被剥掉
        assert_eq!(normalize_version("v0.1.0-rc.6"), "0.1.0-rc.6");
        // 带前缀/尾缀杂质也能提取
        assert_eq!(normalize_version("dsh 0.1.0-rc.6"), "0.1.0-rc.6");
        assert_eq!(normalize_version("0.1.0-rc.6 (build abc)"), "0.1.0-rc.6");
        // 无法解析时回退原串（兼容性检查会明确判定不匹配）
        assert_eq!(normalize_version("garbage"), "garbage");
        assert_eq!(normalize_version(""), "");
    }

    #[test]
    fn windows_cmd_scripts_use_call_for_dsh() {
        // 回归：cmd 对以引号开头的命令行会剥掉首尾引号，dsh 路径含空格时
        // 直接执行会拆碎；.cmd 内必须用 call 前缀。Windows autostart_impl 里
        // 的 web 脚本模板以 `call "{dsh}"` 起行——用等价的最小复现断言该形态
        let dsh_path = r"C:\Users\a b\.npm-global\dsh.cmd";
        let line = format!(
            "call \"{}\" --profile web --host 127.0.0.1 --port 3899",
            dsh_path
        );
        assert!(line.starts_with("call \""));
    }

    #[test]
    fn ws_probe_targets_remote_mux() {
        // WS 探测脚本：发真实 upgrade 握手（curl 的 HTTP/2 假 426 不适用），
        // 拿到 HTTP/1.1 101 即成功；net/tls 双路径，不依赖 Node v22+ 内置
        // WebSocket——Node 18+ 都能跑
        assert!(super::probe::WS_PROBE_JS.contains("HTTP/1.1 101"));
        assert!(super::probe::WS_PROBE_JS.contains("Sec-WebSocket-Key"));
        assert!(super::probe::WS_PROBE_JS.contains("net.connect"));
        assert!(super::probe::WS_PROBE_JS.contains("tls.connect"));
        // 101 → exit 0（成功）；其余状态/错误/超时 → exit 1
        assert!(super::probe::WS_PROBE_JS.contains("?0:1"));
        assert!(super::probe::WS_PROBE_JS.contains("finish(1)"));
        assert!(super::probe::WS_PROBE_JS.contains("process.exit(c)"));
        // 脚本不含双引号：Windows cmd /c 引号转义安全（含双引号会拆碎 -e 参数）
        assert!(!super::probe::WS_PROBE_JS.contains('"'));
        assert!(!super::probe::WS_PROBE_JS.contains("pub(crate)"));
        if let Some(node) = which("node") {
            let (_, stderr, ok) = run_capture(
                &node,
                &["-e", "new Function(process.argv[1])", super::probe::WS_PROBE_JS],
            )
            .unwrap();
            assert!(ok, "WS probe JavaScript must parse: {stderr}");
        }
    }

    #[test]
    fn ws_url_rewrites_https_to_wss() {
        // ws_endpoint_ok 的 URL 改写：https:// → wss://，拼 /api/remote.mux
        let url = "https://etmacmini.taildde4.ts.net";
        let ws_url = format!("{}{}", url.replacen("https://", "wss://", 1), REMOTE_WS_PATH);
        assert_eq!(ws_url, "wss://etmacmini.taildde4.ts.net/api/remote.mux");
    }

    #[test]
    fn remote_url_access_classifies_local_proxy_interference() {
        assert_eq!(
            classify_remote_url_access(true, true, None, true, false, false),
            RemoteUrlAccess::ProxyInterference
        );
        assert_eq!(
            classify_remote_url_access(true, true, None, true, true, true),
            RemoteUrlAccess::Ready
        );
        assert_eq!(
            classify_remote_url_access(false, true, None, true, false, false),
            RemoteUrlAccess::EndpointFailure
        );
        assert_eq!(
            classify_remote_url_access(
                true,
                true,
                Some(RemoteRpcAccess::Denied),
                false,
                false,
                false,
            ),
            RemoteUrlAccess::CapabilityDenied
        );
        assert_eq!(
            classify_remote_url_access(
                true,
                true,
                Some(RemoteRpcAccess::Failed),
                false,
                false,
                false,
            ),
            RemoteUrlAccess::EndpointFailure
        );
    }

    #[test]
    fn macos_proxy_requires_an_explicit_tailnet_bypass() {
        let output = r#"<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 10.0.0.0/8
    2 : *.local
  }
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
}"#;
        let proxy = parse_macos_https_proxy(output).expect("enabled HTTPS proxy");
        assert_eq!(proxy.server, "127.0.0.1");
        assert_eq!(proxy.port, 1082);
        assert!(!proxy_bypasses_host(
            "etmacminim4.taildde4.ts.net",
            &proxy.exceptions
        ));

        let exact = vec!["etmacminim4.taildde4.ts.net".to_string()];
        assert!(proxy_bypasses_host("etmacminim4.taildde4.ts.net", &exact));
        let suffix = vec!["*.taildde4.ts.net".to_string()];
        assert!(proxy_bypasses_host("etmacminim4.taildde4.ts.net", &suffix));
        let tailscale_cidr = vec!["100.64.0.0/10".to_string()];
        assert!(!proxy_bypasses_host(
            "etmacminim4.taildde4.ts.net",
            &tailscale_cidr
        ));
    }

    #[test]
    fn proxy_bypass_uses_only_the_exact_remote_host() {
        assert_eq!(
            proxy_bypass_host("https://etmacminim4.taildde4.ts.net"),
            Some("etmacminim4.taildde4.ts.net")
        );
        assert_eq!(proxy_bypass_host("not-a-remote-url"), None);
    }

    #[test]
    fn direct_https_probe_explicitly_ignores_proxy_settings() {
        let args = curl_direct_args("https://etmacminim4.taildde4.ts.net");
        let no_proxy = args.iter().position(|arg| arg == "--noproxy").unwrap();
        assert_eq!(args[no_proxy + 1], "*");
    }

    #[test]
    fn remote_settings_probe_posts_the_privileged_rpc_directly() {
        let args = curl_remote_rpc_args(
            "https://etmacminim4.taildde4.ts.net/",
            "settings/describe",
        );
        let no_proxy = args.iter().position(|arg| arg == "--noproxy").unwrap();
        assert_eq!(args[no_proxy + 1], "*");
        let body = args.iter().position(|arg| arg == "--data-binary").unwrap();
        assert_eq!(
            args[body + 1],
            r#"{"type":"client-request","rpcId":"t1","method":"settings/describe","payload":{"args":{}}}"#,
        );
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://etmacminim4.taildde4.ts.net/api/settings/describe"),
        );
    }

    #[test]
    fn remote_rpc_probe_distinguishes_capability_denial() {
        assert_eq!(
            classify_remote_rpc_response(
                r#"{"type":"server-response","rpcId":"t1","result":{"ok":true,"value":{}}}
200"#,
                true,
            ),
            RemoteRpcAccess::Ready,
        );
        assert_eq!(
            classify_remote_rpc_response("forbidden\n403", true),
            RemoteRpcAccess::Denied,
        );
        assert_eq!(
            classify_remote_rpc_response(
                r#"{"type":"server-response","rpcId":"t1","result":{"ok":false}}
200"#,
                true,
            ),
            RemoteRpcAccess::Failed,
        );
        assert_eq!(
            classify_remote_rpc_response("\n000", false),
            RemoteRpcAccess::Failed,
        );
    }

    #[test]
    fn rpc_request_is_loopback_json_post() {
        // 敏感 API 校验请求：Host 为 loopback、无 Origin、JSON body 与
        // Content-Length 一致。
        let req = rpc_request("settings/describe");
        assert!(req.starts_with("POST /api/settings/describe HTTP/1.1\r\n"));
        assert!(req.contains("Host: 127.0.0.1"));
        assert!(req.contains("Content-Type: application/json"));
        assert!(!req.contains("Origin:"));
        let body =
            r#"{"type":"client-request","rpcId":"t1","method":"settings/describe","payload":{"args":{}}}"#;
        assert!(req.contains(body));
        assert!(req.contains(&format!("Content-Length: {}\r\n", body.len())));
    }

    #[test]
    fn serve_failure_solution_branches_on_tls_hint() {
        // 教程 3.3：HTTPS Certificates 是与 MagicDNS 独立的开关；serve 报
        // TLS 证书类错误时方案指向 admin/dns，其余才指向 serve 授权链接
        set_current("en");
        let tls_err = "500 Internal Server Error: your Tailscale account does not support getting TLS certs";
        assert_eq!(
            serve_failure_solution(tls_err),
            "MagicDNS or HTTPS Certificates may not be enabled; open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry"
        );
        let serve_err = "Serve is not enabled on your tailnet. To enable Serve, visit: https://login.tailscale.com/f/serve?node=abc";
        assert_eq!(
            serve_failure_solution(serve_err),
            "Open the authorization link in the error output to enable Serve for this tailnet (https://login.tailscale.com/f/serve), then retry"
        );
        // 旧 Tailscale 不认识 --accept-app-caps：提示升级而非指向 serve 授权链接
        let old_ts_err = "unknown flag: --accept-app-caps";
        assert_eq!(
            serve_failure_solution(old_ts_err),
            "Tailscale 1.92+ is required to forward App Capabilities; update Tailscale, then retry"
        );
        set_current("en");
    }

    // ============ 模型配置（models.rs）============

    use super::models::{load_model_config_at, save_model_config_at, ModelConfig, ProviderConfig};

    fn temp_settings_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-models-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir.join("settings.yaml")
    }

    #[test]
    fn model_config_save_then_load_roundtrip() {
        set_current("en");
        let path = temp_settings_path("roundtrip");
        let config = ModelConfig {
            default_provider: Some("spero-ai".into()),
            default_model: Some("glm-5.2".into()),
            default_reasoning_effort: Some("max".into()),
            providers: vec![ProviderConfig {
                route: "spero-ai".into(),
                display_name: Some("Spero AI".into()),
                base_url: Some("https://proxy.example.com/v1".into()),
                api: Some("openai-responses".into()),
                api_key_env: Some("SPERO_AI_API_KEY".into()),
                models: vec!["glm-5.2".into(), "kimi-for-coding".into()],
                extra: serde_json::json!({ "timeoutMs": 60000 }),
            }],
        };
        save_model_config_at(&path, &config).expect("save");
        let text = std::fs::read_to_string(&path).unwrap();
        // 管理键写入 YAML 形态正确（camelCase 与 dsh schema 一致）
        assert!(text.contains("agent-default-model:"));
        assert!(text.contains("reasoningEffort: max"));
        assert!(text.contains("apiKeyEnv: SPERO_AI_API_KEY"));

        let loaded = load_model_config_at(&path).expect("load");
        assert_eq!(loaded.default_provider.as_deref(), Some("spero-ai"));
        assert_eq!(loaded.default_model.as_deref(), Some("glm-5.2"));
        assert_eq!(loaded.default_reasoning_effort.as_deref(), Some("max"));
        assert_eq!(loaded.providers.len(), 1);
        let p = &loaded.providers[0];
        assert_eq!(p.route, "spero-ai");
        assert_eq!(p.display_name.as_deref(), Some("Spero AI"));
        assert_eq!(p.api.as_deref(), Some("openai-responses"));
        assert_eq!(p.models, vec!["glm-5.2".to_string(), "kimi-for-coding".to_string()]);
        // 非管理键经 extra 原样保留
        assert_eq!(p.extra, serde_json::json!({ "timeoutMs": 60000 }));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn model_config_save_preserves_foreign_keys_and_strips_managed_from_extra() {
        set_current("en");
        let path = temp_settings_path("preserve");
        // 预置 settings.yaml：模型域之外的键 + 既有 provider 的高级字段
        std::fs::write(
            &path,
            "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nllm-deepseek:\n  baseURL: https://api.deepseek.com\n  apiKeyEnv: DEEPSEEK_API_KEY\nllm-pi-ai:\n  providers:\n    old-route:\n      displayName: Old\n      streamIdleTimeoutMs: 1000\n",
        )
        .unwrap();
        let config = ModelConfig {
            default_provider: Some("deepseek-official".into()),
            default_model: Some("deepseek-v4-pro".into()),
            default_reasoning_effort: None,
            providers: vec![ProviderConfig {
                route: "new-route".into(),
                display_name: None,
                base_url: None,
                api: Some("anthropic-messages".into()),
                api_key_env: None,
                models: Vec::new(),
                // extra 混入管理键：保存时必须被剥离（后写覆盖语义不许出现）
                extra: serde_json::json!({ "displayName": "HACK", "retryPolicy": { "mode": "normal" } }),
            }],
        };
        save_model_config_at(&path, &config).expect("save");
        let text = std::fs::read_to_string(&path).unwrap();
        // 模型域之外的顶层键原样保留
        assert!(text.contains("ui-onboarding:"));
        assert!(text.contains("llm-deepseek:"));
        assert!(text.contains("DEEPSEEK_API_KEY"));
        // 旧路由被 UI 状态整体替换；新路由高级字段保留、混入的管理键被剥离
        assert!(!text.contains("old-route"));
        assert!(text.contains("new-route"));
        assert!(text.contains("retryPolicy:"));
        assert!(!text.contains("HACK"));
        // agent-default-model 无 reasoningEffort 时不得写出空值
        let loaded = load_model_config_at(&path).unwrap();
        assert_eq!(loaded.default_reasoning_effort, None);
        assert_eq!(loaded.providers[0].extra, serde_json::json!({ "retryPolicy": { "mode": "normal" } }));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn model_config_empty_providers_removes_llm_pi_ai_key() {
        set_current("en");
        let path = temp_settings_path("empty");
        std::fs::write(&path, "llm-pi-ai:\n  providers:\n    a:\n      api: openai-responses\nagent-presets:\n  default: minimal\n").unwrap();
        let config = ModelConfig {
            default_provider: None,
            default_model: None,
            default_reasoning_effort: None,
            providers: Vec::new(),
        };
        save_model_config_at(&path, &config).expect("save");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("llm-pi-ai"));
        assert!(!text.contains("agent-default-model"));
        assert!(text.contains("agent-presets:"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn model_config_missing_file_loads_empty() {
        set_current("en");
        let path = temp_settings_path("missing-nonexistent").join("nested").join("settings.yaml");
        let loaded = load_model_config_at(&path).expect("load");
        assert_eq!(loaded.providers.len(), 0);
        assert_eq!(loaded.default_provider, None);
    }

    // ============ 插件市场（market.rs）============

    use super::market::plugin_from_json;

    #[test]
    fn market_plugin_projection_reads_candidate_and_validation() {
        let item: serde_json::Value = serde_json::from_str(
            r#"{
                "repositoryId": 1326893710,
                "fullName": "omdsh-dev/DSH-better-sidebar",
                "name": "DSH-better-sidebar",
                "description": "侧边栏底座",
                "url": "https://github.com/omdsh-dev/DSH-better-sidebar",
                "stars": 3120,
                "category": "ui",
                "language": "TypeScript",
                "starTrend": { "points": [1, 2, 3] },
                "validation": { "overall": "verified" },
                "install": {
                    "candidate": {
                        "action": "add",
                        "specifier": "npm:dsh-better-sidebar@latest",
                        "command": "dsh plugin --profile web add dsh-better-sidebar@latest",
                        "executable": true
                    }
                }
            }"#,
        )
        .unwrap();
        let p = plugin_from_json(&item).expect("project");
        assert_eq!(p.full_name, "omdsh-dev/DSH-better-sidebar");
        assert!(p.verified);
        assert_eq!(p.install_specifier.as_deref(), Some("npm:dsh-better-sidebar@latest"));
        assert!(p.install_executable);
        assert_eq!(p.stars, 3120);
    }

    #[test]
    fn market_plugin_without_verified_or_candidate_is_not_installable() {
        // 验证状态只认 overall == "verified"
        let unverified: serde_json::Value = serde_json::from_str(
            r#"{ "fullName": "a/b", "validation": { "overall": "sandbox-failed" } }"#,
        )
        .unwrap();
        let p = plugin_from_json(&unverified).unwrap();
        assert!(!p.verified);
        // 无 install.candidate → 不可一键安装
        let nocand: serde_json::Value =
            serde_json::from_str(r#"{ "fullName": "a/b", "install": { "status": "ambiguous" } }"#).unwrap();
        let p = plugin_from_json(&nocand).unwrap();
        assert_eq!(p.install_specifier, None);
        assert!(!p.install_executable);
        // 非 add 动作不产生安装标识
        let other: serde_json::Value = serde_json::from_str(
            r#"{ "fullName": "a/b", "install": { "candidate": { "action": "manual", "specifier": "x" } } }"#,
        )
        .unwrap();
        let p = plugin_from_json(&other).unwrap();
        assert_eq!(p.install_specifier, None);
        // 缺 fullName 的条目被丢弃
        assert!(plugin_from_json(&serde_json::json!({ "name": "orphan" })).is_none());
    }

    use super::market::valid_identifier;

    #[test]
    fn market_identifier_whitelist_rejects_hostile_input() {
        assert!(valid_identifier("npm:dsh-better-sidebar@latest"));
        assert!(valid_identifier("@scope/pkg-name_1.0"));
        assert!(valid_identifier("github:owner/repo#c0ffee"));
        assert!(!valid_identifier(""));
        assert!(!valid_identifier("-flag"));
        // 相对路径 spec 会被 dsh 锚定到调用方 cwd，语义不受控
        assert!(!valid_identifier("./local"));
        assert!(!valid_identifier(".hidden"));
        assert!(!valid_identifier("a b"));
        assert!(!valid_identifier("a\nb"));
        assert!(!valid_identifier("../escape"));
        assert!(!valid_identifier("$(cmd)"));
        assert!(!valid_identifier(&"x".repeat(300)));
    }

    #[test]
    fn market_installed_marks_managed_plugins() {
        set_current("en");
        use super::market::installed_list_from_profile;
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-market-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let profile = dir.join("package.json");
        std::fs::write(
            &profile,
            r#"{ "dependencies": { "@dsh-external/dsh-auth-tailscale": "file:/x.tgz", "dsh-better-sidebar": "npm:dsh-better-sidebar@1.0.0" } }"#,
        )
        .unwrap();
        let list = installed_list_from_profile(&profile).expect("list");
        assert_eq!(list.len(), 2);
        let managed = list.iter().find(|p| p.name == "@dsh-external/dsh-auth-tailscale").unwrap();
        assert!(managed.managed);
        let community = list.iter().find(|p| p.name == "dsh-better-sidebar").unwrap();
        assert!(!community.managed);
        assert_eq!(community.spec, "npm:dsh-better-sidebar@1.0.0");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[ignore] // 依赖外网真实 API（27MB），仅手动验证链路时跑：cargo test market_fetch_real -- --ignored
    fn market_fetch_real_catalog_smoke() {
        let catalog = super::market::fetch_catalog().expect("fetch real catalog");
        assert!(catalog.plugins.len() > 1000, "unexpectedly small catalog: {}", catalog.plugins.len());
        assert!(catalog.plugins.iter().any(|p| p.install_specifier.is_some() && p.install_executable));
        assert!(catalog.plugins.iter().any(|p| p.verified));
    }
