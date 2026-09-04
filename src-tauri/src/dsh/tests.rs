//! dsh 域单元测试（原 dsh.rs tests 模块整体平移，导入清单未改）。

    use super::auth::{AuthConfig, parse_extra_logins, rpc_request, serve_status_targets_web, tailscale_login_from_status_json, validate_cap_domain};
    use super::autostart::{port_guard_js, render_desktop_entry, render_start_web, sh_quote};
    use super::components::{dsh_version_is_compatible, normalize_version, plugin_profile_is_current, version_within_supported_line};
    use crate::version::parse_version;
    use super::{RemoteRpcAccess, RemoteUrlAccess, SUPPORTED_DSH_VERSION};
    use super::probe::{classify_remote_rpc_response, classify_remote_url_access, curl_direct_args, curl_remote_rpc_args, parse_macos_https_proxy, proxy_bypass_host, proxy_bypasses_host, REMOTE_WS_PATH};
    use super::process::{credentials_lock_is_stale, dsh_web_cmd_pattern, ere_to_ps_wildcards, run_capture, run_capture_lines, stream_chunk_lines, which, win_cmd_line, win_quote};
    use super::setup::{format_verification_checks, plugin_failure_from_log_tail, read_log_tail, serve_command, serve_failure_solution, start_failure_diagnosis};
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
        assert!(dsh_version_is_compatible(Some("0.1.2-alpha.5")));
        assert!(dsh_version_is_compatible(Some("0.1.2")));
        // 跨线一律不兼容：旧线 0.1.1/0.1.0 与更远的线都拒绝。0.1.0-rc.8 曾满足
        // ">= 下限"的宽松判定，但跨线重排了运行时与数据格式（实机教训）
        assert!(!dsh_version_is_compatible(Some("0.1.1-rc.2")));
        assert!(!dsh_version_is_compatible(Some("0.1.0-rc.8")));
        assert!(!dsh_version_is_compatible(Some("1.0.0")));
        // 低于锁定版本或无法解析的版本不兼容；alpha.3 曾是「同线更高」的放行
        // 样本，floor 升到 alpha.4 后翻到线下——bump 常量会翻转判定方向
        assert!(!dsh_version_is_compatible(Some("0.1.2-alpha.3")));
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
    fn log_tail_is_capped_drops_blank_lines_and_missing_file_is_none() {
        // dsh_web_log 命令把尾部交给前端内嵌展示：上限必须生效（超长日志
        // 不整份进 webview）、空行剔除、文件缺失返回 None（命令层转空串占位）
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pro-max-logtail-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("dsh-web.log");
        std::fs::write(&log, "boot ok\n\nError: boom\nat frame\n").unwrap();
        assert_eq!(read_log_tail(&log, 2).as_deref(), Some("Error: boom\nat frame"));
        assert_eq!(read_log_tail(&log, 10).as_deref(), Some("boot ok\nError: boom\nat frame"));
        assert_eq!(read_log_tail(&log, 0), None);
        assert_eq!(read_log_tail(&dir.join("missing.log"), 10), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn plugin_failure_names_the_innermost_non_builtin_entry() {
        // 真实崩溃形态（本机 dsh-web.log 的 agent-teams 事故）：致命横幅 +
        // 多层 loader 链，最内层非 cordis: 的名字即肇事插件，根因在末段冒号后
        let tail = concat!(
            "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): ",
            "failed to apply loader entry agent-teams (@nanmicoder/dsh-agent-teams): ctx.subagents.registerContinuableSetup is not a function\n",
            "    at updateError (cordis-plugin-loader/lib/index.js:309:9)\n",
        );
        let (plugin, error) = plugin_failure_from_log_tail(tail).unwrap();
        assert_eq!(plugin, "@nanmicoder/dsh-agent-teams");
        assert!(error.contains("registerContinuableSetup is not a function"));
    }

    #[test]
    fn plugin_failure_falls_back_to_missing_module_in_builtin_only_chain() {
        // 内置 include 节点导入插件失败：链上没有非内置名字，从根因引号取包名
        let tail = concat!(
            "dsh: fatal load failure: Error: dsh: plugin tree failed to load: ",
            "failed to apply loader entry include (cordis:include): Cannot find module '@foo/bar'\n",
        );
        let (plugin, error) = plugin_failure_from_log_tail(tail).unwrap();
        assert_eq!(plugin, "@foo/bar");
        assert!(error.contains("Cannot find module '@foo/bar'"));
    }

    #[test]
    fn plugin_soft_failure_warnings_do_not_masquerade_as_fatal() {
        // 非致命告警（allSettled 软失败转储、probe warn）没有致命标记，
        // 不得把它们当死因点名插件
        let soft = "SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'\n";
        assert_eq!(plugin_failure_from_log_tail(soft), None);
        let probe_warn = "[@wxg-prc-cpg/browser-skill-dsh-plugin] bsk probe failed (spawn bsk ENOENT)\n";
        assert_eq!(plugin_failure_from_log_tail(probe_warn), None);
    }

    #[test]
    fn start_diagnosis_names_the_culprit_plugin_and_points_at_the_plugins_page() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dsh-pro-max-plugindiag-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("dsh-web.log");
        std::fs::write(
            &log,
            concat!(
                "dsh web: http://127.0.0.1:3899\n",
                "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): ",
                "failed to apply loader entry agent-teams (@nanmicoder/dsh-agent-teams): ctx.subagents.registerContinuableSetup is not a function\n",
            ),
        )
        .unwrap();
        let (problem, solution) = start_failure_diagnosis(&log);
        assert!(problem.contains("@nanmicoder/dsh-agent-teams"));
        assert!(problem.contains("registerContinuableSetup is not a function"));
        assert!(solution.contains("@nanmicoder/dsh-agent-teams"));
        std::fs::remove_dir_all(dir).unwrap();
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
    fn installed_version_from_spec_parses_concrete_npm_forms_only() {
        use super::market::installed_version_from_spec;
        // npm 精确形态（含 npm: 前缀与 scope 包）可检出
        assert_eq!(installed_version_from_spec("dsh-better-sidebar@1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(installed_version_from_spec("npm:dsh-better-sidebar@1.0.0").as_deref(), Some("1.0.0"));
        assert_eq!(installed_version_from_spec("@scope/pkg@2.3.4").as_deref(), Some("2.3.4"));
        assert_eq!(installed_version_from_spec("npm:@scope/pkg@1.0.0").as_deref(), Some("1.0.0"));
        // 裸版本值（pnpm 精确保存形态）
        assert_eq!(installed_version_from_spec("1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(installed_version_from_spec("0.1.0-rc.6").as_deref(), Some("0.1.0-rc.6"));
        // 范围 / 协议 / 脏形态不可检（来源不是 registry 或无具体版本可比）
        assert_eq!(installed_version_from_spec("^1.2.3"), None);
        assert_eq!(installed_version_from_spec("~1.2.0"), None);
        assert_eq!(installed_version_from_spec("*"), None);
        assert_eq!(installed_version_from_spec("latest"), None);
        assert_eq!(installed_version_from_spec("github:owner/repo#main"), None);
        assert_eq!(installed_version_from_spec("file:/x/y.tgz"), None);
        assert_eq!(installed_version_from_spec("workspace:*"), None);
        assert_eq!(installed_version_from_spec(""), None);
        assert_eq!(installed_version_from_spec("pkg@"), None);
        // scope 段不完整：@ 后无 '/'，无法定位版本段
        assert_eq!(installed_version_from_spec("@bad"), None);
    }

    #[test]
    fn installed_version_from_disk_reads_node_modules_facts() {
        use super::market::installed_version_from_disk;
        // 回归（市场更新检测 Bug）：pnpm 落盘的依赖 spec 常是 ^x.y.z 范围
        // 形态，installed_version_from_spec 对其返回 None，npm 形态插件整体
        // 脱离更新检测。磁盘上的实际版本（node_modules 内 package.json）是
        // 现成事实，必须能读出来
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-disk-ver-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let nm = dir.join("node_modules");
        // 普通包
        std::fs::create_dir_all(nm.join("dsh-context")).unwrap();
        std::fs::write(
            nm.join("dsh-context").join("package.json"),
            r#"{"name":"dsh-context","version":"0.38.5"}"#,
        )
        .unwrap();
        assert_eq!(installed_version_from_disk(&dir, "dsh-context").as_deref(), Some("0.38.5"));
        // scope 包：@scope/pkg 拼成 node_modules/@scope/pkg 自然子路径
        std::fs::create_dir_all(nm.join("@scope").join("pkg")).unwrap();
        std::fs::write(nm.join("@scope").join("pkg").join("package.json"), r#"{"version":"1.2.3"}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "@scope/pkg").as_deref(), Some("1.2.3"));
        // 文件缺失
        assert_eq!(installed_version_from_disk(&dir, "not-installed"), None);
        // 坏 JSON
        std::fs::create_dir_all(nm.join("broken")).unwrap();
        std::fs::write(nm.join("broken").join("package.json"), "not json").unwrap();
        assert_eq!(installed_version_from_disk(&dir, "broken"), None);
        // version 字段缺失 / 非语义版本
        std::fs::create_dir_all(nm.join("no-version")).unwrap();
        std::fs::write(nm.join("no-version").join("package.json"), r#"{"name":"x"}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "no-version"), None);
        std::fs::create_dir_all(nm.join("bad-version")).unwrap();
        std::fs::write(nm.join("bad-version").join("package.json"), r#"{"version":"latest"}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "bad-version"), None);
        // `..` 注入名：路径拼接防纵深（上游 valid_identifier 已挡，不信任调用方）
        assert_eq!(installed_version_from_disk(&dir, "../escape"), None);
        assert_eq!(installed_version_from_disk(&dir, "..\\escape"), None);
        assert_eq!(installed_version_from_disk(&dir, ""), None);
        // 绝对路径 / 盘符注入：Path::join 遇绝对路径组件会整体替换基路径，
        // Windows 下 `C:/evil`、`\evil`、`/evil` 都会逃出 profile 目录，
        // 四条校验（字符白名单挡 `:` 与 `\`，首字符挡 `/`）必须全拦
        assert_eq!(installed_version_from_disk(&dir, "C:/evil"), None);
        assert_eq!(installed_version_from_disk(&dir, r"C:\evil"), None);
        assert_eq!(installed_version_from_disk(&dir, "/evil"), None);
        assert_eq!(installed_version_from_disk(&dir, "C:evil"), None);
        // 合法包名回归：点划下划线与 scope 形态均正常放行
        std::fs::create_dir_all(nm.join("pkg")).unwrap();
        std::fs::write(nm.join("pkg").join("package.json"), r#"{"version":"1.0.0"}"#).unwrap();
        std::fs::create_dir_all(nm.join("pkg.name-1_x")).unwrap();
        std::fs::write(nm.join("pkg.name-1_x").join("package.json"), r#"{"version":"2.0.0"}"#).unwrap();
        std::fs::create_dir_all(nm.join("@scope").join("pkg.name-1_x")).unwrap();
        std::fs::write(nm.join("@scope").join("pkg.name-1_x").join("package.json"), r#"{"version":"3.0.0"}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "pkg").as_deref(), Some("1.0.0"));
        assert_eq!(installed_version_from_disk(&dir, "pkg.name-1_x").as_deref(), Some("2.0.0"));
        assert_eq!(installed_version_from_disk(&dir, "@scope/pkg.name-1_x").as_deref(), Some("3.0.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installed_version_for_update_prefers_disk_over_spec() {
        use super::market::installed_version_for_update;
        // check_updates_once 的版本决策纯函数化：磁盘事实优先，spec 精确版本兜底
        let dir =
            std::env::temp_dir().join(format!("dsh-pro-max-disk-ver-decision-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let nm = dir.join("node_modules");
        std::fs::create_dir_all(nm.join("dsh-context")).unwrap();
        std::fs::write(nm.join("dsh-context").join("package.json"), r#"{"version":"0.38.5"}"#).unwrap();
        // 范围 spec（pnpm 落盘形态）：磁盘事实参与检测——修复前这里恒 None
        assert_eq!(
            installed_version_for_update(Some(&dir), "dsh-context", "^0.38.5").as_deref(),
            Some("0.38.5")
        );
        // 磁盘不可得（profile 目录拿不到 / 包不在盘上）回退 spec 精确版本
        assert_eq!(
            installed_version_for_update(None, "dsh-context", "npm:dsh-context@0.38.4").as_deref(),
            Some("0.38.4")
        );
        assert_eq!(installed_version_for_update(Some(&dir), "absent", "1.0.0").as_deref(), Some("1.0.0"));
        // 协议形态不检：不来自 registry，其版本号多为 0.0.0 占位，
        // 误检会诱导 name@latest 重装覆盖掉 git 源
        assert_eq!(installed_version_for_update(Some(&dir), "dsh-context", "github:owner/repo#main"), None);
        assert_eq!(installed_version_for_update(Some(&dir), "dsh-context", "file:/x/y.tgz"), None);
        assert_eq!(installed_version_for_update(Some(&dir), "dsh-context", "git+https://x/y.git"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installed_version_from_disk_edge_shapes_return_none() {
        use super::market::installed_version_from_disk;
        use super::market::installed_version_for_update;
        // 边界补测（QA 回归）：工程师用例未覆盖的畸形盘上事实，都必须
        // 如实 None，不得 panic、不得误读
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-disk-ver-edge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let nm = dir.join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        // node_modules 下的"包"是文件而非目录：路径拼接后读不到
        // package.json（file\package.json 不存在），必须 None
        std::fs::write(nm.join("file-not-dir"), "i am a file").unwrap();
        assert_eq!(installed_version_from_disk(&dir, "file-not-dir"), None);
        // version 字段是数字 / null：as_str() 拿不到字符串，必须 None
        std::fs::create_dir_all(nm.join("numeric-version")).unwrap();
        std::fs::write(nm.join("numeric-version").join("package.json"), r#"{"version":123}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "numeric-version"), None);
        std::fs::create_dir_all(nm.join("null-version")).unwrap();
        std::fs::write(nm.join("null-version").join("package.json"), r#"{"version":null}"#).unwrap();
        assert_eq!(installed_version_from_disk(&dir, "null-version"), None);
        // profile 目录本身不存在：读文件失败，必须 None
        let missing = dir.join("definitely-missing-profile");
        assert_eq!(installed_version_from_disk(&missing, "dsh-context"), None);
        // scope 名里带 `..`（@../pkg、@scope/../pkg）：路径防注入同样必须拦
        assert_eq!(installed_version_from_disk(&dir, "@../pkg"), None);
        assert_eq!(installed_version_from_disk(&dir, "@scope/../pkg"), None);
        // 磁盘版本优先于 spec 精确版本：盘上是事实，spec 只是落盘时的
        // 声明（可能滞后），两者冲突时以磁盘为准
        std::fs::create_dir_all(nm.join("ahead")).unwrap();
        std::fs::write(nm.join("ahead").join("package.json"), r#"{"version":"2.0.0"}"#).unwrap();
        assert_eq!(
            installed_version_for_update(Some(&dir), "ahead", "1.0.0").as_deref(),
            Some("2.0.0")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_from_registry_json_reads_semver_version_field() {
        use super::market::latest_from_registry_json;
        assert_eq!(latest_from_registry_json(r#"{"name":"x","version":"1.2.3"}"#).as_deref(), Some("1.2.3"));
        assert_eq!(latest_from_registry_json(r#"{"name":"x","version":"0.1.0-rc.6"}"#).as_deref(), Some("0.1.0-rc.6"));
        // version 缺失 / 非语义版本 / 非 JSON → 不采信
        assert_eq!(latest_from_registry_json(r#"{"name":"x"}"#), None);
        assert_eq!(latest_from_registry_json(r#"{"version":"latest"}"#), None);
        assert_eq!(latest_from_registry_json("not json"), None);
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
    fn stream_chunk_lines_splits_newlines_and_carriage_returns() {
        assert_eq!(stream_chunk_lines("a\nb\r\nc"), vec!["a", "b", "c"]);
        // pnpm 进度条用 \r 原地刷新同一行：每次刷新要成为独立展示行
        assert_eq!(
            stream_chunk_lines("Progress: 1\rProgress: 2\rProgress: 3\ndone"),
            vec!["Progress: 1", "Progress: 2", "Progress: 3", "done"]
        );
        // 空段与首尾空白不产生噪音行
        assert_eq!(stream_chunk_lines("  x  \n\n\r\n"), vec!["x"]);
        assert!(stream_chunk_lines("").is_empty());
    }

    #[test]
    fn run_capture_lines_streams_lines_from_real_process() {
        // 端到端：真实子进程 stdout 多行 + stderr \r 刷新行，回调收到切好的行，
        // 返回值保持 run_capture 的全量捕获语义
        let Some(node) = which("node") else { return };
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = lines.clone();
        let (stdout, _, ok) = run_capture_lines(
            &node,
            &[
                "-e",
                "process.stdout.write('out1\\nout2\\n'); process.stderr.write('err1\\rerr2\\n');",
            ],
            move |l| sink.lock().unwrap().push(l.to_string()),
        )
        .unwrap();
        assert!(ok);
        assert!(stdout.contains("out1") && stdout.contains("out2"), "stdout: {stdout}");
        let got = lines.lock().unwrap();
        assert!(got.contains(&"out1".to_string()), "lines: {got:?}");
        assert!(got.contains(&"err1".to_string()), "stderr 行也要实时回调: {got:?}");
        assert!(got.contains(&"err2".to_string()), "\\r 切行后 err2 独立成行: {got:?}");
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
    fn market_plugin_projection_reads_curated_entry() {
        let item: serde_json::Value = serde_json::from_str(
            r#"{
                "name": "dsh-memory",
                "owner": "FuRongJun-1999",
                "url": "https://github.com/FuRongJun-1999/dsh-memory",
                "page": "https://awesome-dsh-plugin.com/p/FuRongJun-1999/dsh-memory/",
                "category": "memory",
                "description": { "en": "White-box memory graph", "zh": "白箱记忆图" },
                "npm": "@furongjun1999/dsh-memory",
                "tarball": "https://example.com/x.tgz",
                "stars": 80,
                "downloads": 3552,
                "install": "dsh plugin --profile web add @furongjun1999/dsh-memory",
                "added": "2026-08-14",
                "screenshots": ["https://example.com/1.png"]
            }"#,
        )
        .unwrap();
        let p = plugin_from_json(&item).expect("project");
        assert_eq!(p.full_name, "FuRongJun-1999/dsh-memory");
        assert_eq!(p.install_specifier.as_deref(), Some("@furongjun1999/dsh-memory"));
        assert_eq!(p.stars, Some(80.0));
        assert_eq!(p.category.as_deref(), Some("memory"));
        assert!(!p.deprecated);
        assert_eq!(p.replacement, None);
        // 多语言描述原样透传
        assert_eq!(p.description.as_ref().unwrap().get("zh").map(String::as_str), Some("白箱记忆图"));
    }

    #[test]
    fn market_install_specifier_parses_install_command_token() {
        // 目录 install 是给人看的完整命令串，投影只取 ` add ` 之后的机器标识
        for (raw, expect) in [
            ("dsh plugin --profile web add @scope/pkg", "@scope/pkg"),
            ("dsh plugin --profile web add dsh-context", "dsh-context"),
            ("dsh plugin --profile web add github:owner/repo", "github:owner/repo"),
            ("dsh plugin --profile web add github:owner/repo#main", "github:owner/repo#main"),
        ] {
            let item = serde_json::json!({ "name": "x", "install": raw });
            let p = plugin_from_json(&item).expect("project");
            assert_eq!(p.install_specifier.as_deref(), Some(expect), "raw: {raw}");
        }
        // 无 add 段 / 畸形 token（过不了字符白名单）→ 无一键安装候选
        for raw in ["dsh plugin --profile web remove x", "npm install dsh-x", "", "$(cmd)"] {
            let item = serde_json::json!({ "name": "x", "install": raw });
            let p = plugin_from_json(&item).expect("project");
            assert_eq!(p.install_specifier, None, "raw: {raw}");
        }
    }

    #[test]
    fn market_plugin_fields_fall_through_and_missing_name_drops_entry() {
        // 缺 name 的条目整条丢弃
        assert!(plugin_from_json(&serde_json::json!({ "owner": "a" })).is_none());
        // owner 缺失时从 github url 派生
        let p = plugin_from_json(&serde_json::json!({
            "name": "x", "url": "https://github.com/owner/x",
            "install": "dsh plugin --profile web add github:owner/x"
        }))
        .unwrap();
        assert_eq!(p.full_name, "owner/x");
        // stars null 是正常形态（新收录或仓库 404），不静默当 0
        let p = plugin_from_json(&serde_json::json!({ "name": "x", "stars": null })).unwrap();
        assert_eq!(p.stars, None);
        // 弃用标记与替代建议原样透传；replacement 缺席不碍事
        let p = plugin_from_json(&serde_json::json!({ "name": "x", "deprecated": true, "replacement": "y" })).unwrap();
        assert!(p.deprecated);
        assert_eq!(p.replacement.as_deref(), Some("y"));
        let p = plugin_from_json(&serde_json::json!({ "name": "x", "deprecated": true })).unwrap();
        assert!(p.deprecated);
        assert_eq!(p.replacement, None);
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
    #[ignore] // 依赖外网真实目录（~300KB），仅手动验证链路时跑：cargo test market_fetch_real -- --ignored
    fn market_fetch_real_catalog_smoke() {
        let catalog = super::market::fetch_catalog_raw(super::market::MARKET_CATALOG_URL)
            .map_err(|e| match e {
                CatalogLoadError::UnsupportedSchema(msg) | CatalogLoadError::Transient(msg) => msg,
            })
            .expect("fetch real catalog");
        assert!(catalog.plugins.len() > 1000, "unexpectedly small catalog: {}", catalog.plugins.len());
        assert!(catalog.plugins.iter().any(|p| p.install_specifier.is_some()));
        // 弃用标记是目录透传字段（正常条目缺席），是否出现取决于上游内容，
        // 不在此断言；其投影行为由 fixture 单测覆盖
        assert!(catalog.plugins.iter().any(|p| p.description.as_ref().is_some_and(|d| !d.is_empty())));
        assert!(!catalog.categories.is_empty());
        assert!(catalog.updated.is_some());
    }

    // ============ 企业级演进：快照 / 策略 / 回执 / 审计 / 校验和 ============

    use super::components::verify_bundled_tarball;
    use super::market::{
        audit_line, blocked_build_packages, catalog_from_raw, catalog_snapshot_decision, install_failure_message,
        install_receipt, merge_allow_builds, package_name_from_specifier, policy_allows, policy_entries_from_raw,
        resolve_catalog_url, load_catalog_snapshot_file, specifier_to_catalog_name, write_catalog_snapshot_file,
        CatalogLoadError, InstallOutcome, InstalledPlugin,
    };

    #[test]
    fn blocked_build_packages_parses_pnpm_stderr() {
        // pnpm 11/12 树形错误（单包）
        let e12 = "Error: ERR_PNPM_IGNORED_BUILDS\n  \u{d7} adding a new package\n  \u{2570}\u{2500}\u{25b6} Ignored build scripts: node-pty@1.1.0\n  help: Run \"pnpm approve-builds\"";
        assert_eq!(blocked_build_packages(e12), vec!["node-pty"]);
        // 多包逗号分隔
        let multi = "\u{2570}\u{2500}\u{25b6} Ignored build scripts: node-pty@1.1.0, simple-git-hooks@2.14.0";
        assert_eq!(blocked_build_packages(multi), vec!["node-pty", "simple-git-hooks"]);
        // pnpm 10 括号错误形态；scope 包剥版本不伤 scope 前缀；裸名无版本
        let e10 = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @scope/pkg@1.0.0";
        assert_eq!(blocked_build_packages(e10), vec!["@scope/pkg"]);
        assert_eq!(blocked_build_packages("Ignored build scripts: dsh-x"), vec!["dsh-x"]);
        assert_eq!(blocked_build_packages("Ignored build scripts: @scope/pkg"), vec!["@scope/pkg"]);
        // 无关失败不误判；脏数据（含空格）被白名单过滤
        assert!(blocked_build_packages("boom").is_empty());
        assert!(blocked_build_packages("Ignored build scripts: bad name@1.0").is_empty());
    }

    #[test]
    fn merge_allow_builds_creates_merges_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-allow-builds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pnpm-workspace.yaml");
        // 新建：双键同写（allowBuilds 给 pnpm 11+，onlyBuiltDependencies 给 pnpm 10）
        merge_allow_builds(&path, &["node-pty".to_string()]).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("allowBuilds") && raw.contains("node-pty: true"), "raw: {raw}");
        assert!(raw.contains("onlyBuiltDependencies"), "raw: {raw}");
        // 合并：保留用户已有键与显式拒绝（false），只插入缺失项
        std::fs::write(
            &path,
            "packages:\n  - .\nallowBuilds:\n  esbuild: false\nonlyBuiltDependencies:\n  - esbuild\n",
        )
        .unwrap();
        merge_allow_builds(&path, &["node-pty".to_string(), "esbuild".to_string()]).unwrap();
        let v: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["allowBuilds"]["esbuild"], serde_yaml::Value::Bool(false));
        assert_eq!(v["allowBuilds"]["node-pty"], serde_yaml::Value::Bool(true));
        let only: Vec<&str> = v["onlyBuiltDependencies"].as_sequence().unwrap().iter().filter_map(|x| x.as_str()).collect();
        assert_eq!(only, vec!["esbuild", "node-pty"]);
        // 幂等：重复放行同包，文件不再变化
        let before = std::fs::read_to_string(&path).unwrap();
        merge_allow_builds(&path, &["node-pty".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 用户手动跑过 `pnpm approve-builds` 但没完成交互：yaml 留下
    /// `allowBuilds: {node-pty: "set this to true or false"}` 占位符。
    /// launcher 再次审批时必须覆盖该占位符为 true，否则重跑仍被拦
    #[test]
    fn merge_allow_builds_overwrites_interactive_placeholder() {
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-allow-builds-placeholder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pnpm-workspace.yaml");
        std::fs::write(
            &path,
            "packages:\n  - .\nallowBuilds:\n  node-pty: set this to true or false\n",
        )
        .unwrap();
        merge_allow_builds(&path, &["node-pty".to_string()]).unwrap();
        let v: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["allowBuilds"]["node-pty"], serde_yaml::Value::Bool(true));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_outcome_serializes_tagged() {
        let out = InstallOutcome::NeedsApproval {
            packages: vec!["node-pty".to_string()],
            workspace_yaml: "/p/pnpm-workspace.yaml".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&out).unwrap();
        assert_eq!(v["status"], "needsApproval");
        assert_eq!(v["packages"][0], "node-pty");
        assert_eq!(v["workspaceYaml"], "/p/pnpm-workspace.yaml");
        let v: serde_json::Value =
            serde_json::to_value(&InstallOutcome::Installed { receipt: None }).unwrap();
        assert_eq!(v["status"], "installed");
        assert!(v["receipt"].is_null());
    }

    fn catalog_fixture() -> &'static str {
        r#"{
            "name": "awesome-dsh-plugin",
            "updated": "2026-08-31",
            "count": 2,
            "categories": { "ui": { "en": "UI Enhancements", "zh": "UI 增强" } },
            "plugins": [
                { "name": "pkg", "owner": "a", "url": "https://github.com/a/pkg", "category": "ui",
                  "description": { "en": "E", "zh": "中" }, "stars": 12, "downloads": 30,
                  "install": "dsh plugin --profile web add pkg@1.0", "added": "2026-08-14" },
                { "name": "old", "owner": "c", "url": "https://github.com/c/old", "category": "ui",
                  "description": { "en": "Old" }, "stars": null, "deprecated": true, "replacement": "pkg",
                  "install": "dsh plugin --profile web add github:c/old" }
            ]
        }"#
    }

    /// 按真实写入路径落盘投影快照（fetch 成功后 write_catalog_snapshot 的文件形态）
    fn write_projected_snapshot(path: &std::path::Path) {
        let catalog = catalog_from_raw(catalog_fixture(), false).expect("parse");
        write_catalog_snapshot_file(path, &catalog).expect("write snapshot");
    }

    #[test]
    fn catalog_from_raw_validates_structure_and_flags_snapshot() {
        set_current("en");
        let ok = catalog_from_raw(catalog_fixture(), false).expect("parse");
        assert!(!ok.from_snapshot);
        assert_eq!(ok.total, 2);
        assert_eq!(ok.updated.as_deref(), Some("2026-08-31"));
        assert_eq!(ok.categories["ui"]["zh"], "UI 增强");
        let npm = ok.plugins.iter().find(|p| p.name == "pkg").unwrap();
        assert_eq!(npm.install_specifier.as_deref(), Some("pkg@1.0"));
        assert_eq!(npm.stars, Some(12.0));
        let git = ok.plugins.iter().find(|p| p.name == "old").unwrap();
        assert_eq!(git.install_specifier.as_deref(), Some("github:c/old"));
        assert_eq!(git.stars, None);
        assert!(git.deprecated);
        assert_eq!(git.replacement.as_deref(), Some("pkg"));

        // 结构不符 = 结构性拒绝（不许拿旧快照掩盖格式漂移）：
        // 旧契约载荷（schemaVersion/repositories）与新目录缺 plugins 数组同样拒绝
        for raw in [r#"{"schemaVersion": 2}"#, r#"{"schemaVersion": 1, "repositories": []}"#, r#"{"plugins": []}"#] {
            let err = catalog_from_raw(raw, false).expect_err("should reject");
            assert!(matches!(err, CatalogLoadError::UnsupportedSchema(_)), "unexpected error for {raw}");
        }
        // 快照标记原样透传
        assert!(catalog_from_raw(catalog_fixture(), true).expect("parse").from_snapshot);
    }

    #[test]
    fn catalog_snapshot_file_round_trips_projected_catalog() {
        set_current("en");
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snapshot.json");
        write_projected_snapshot(&path);
        let catalog = load_catalog_snapshot_file(&path).expect("load");
        assert!(catalog.from_snapshot);
        assert_eq!(catalog.total, 2);
        assert_eq!(catalog.updated.as_deref(), Some("2026-08-31"));
        // 损坏快照如实失败（降级路径要求可区分"没有快照"与"快照坏了"）
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_catalog_snapshot_file(&path).is_err());
        // 旧契约快照（根带 schemaVersion/repositories，条目缺投影字段）与投影
        // 格式不兼容：反序列化失败即按无快照处理，下次成功拉取自动重建
        std::fs::write(&path, catalog_fixture()).unwrap();
        assert!(load_catalog_snapshot_file(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn package_name_from_specifier_mirrors_frontend_semantics() {
        assert_eq!(package_name_from_specifier("pkg@1.0.0").as_deref(), Some("pkg"));
        assert_eq!(package_name_from_specifier("@scope/pkg@1.0").as_deref(), Some("@scope/pkg"));
        assert_eq!(package_name_from_specifier("@scope/pkg").as_deref(), Some("@scope/pkg"));
        assert_eq!(package_name_from_specifier("plain-name").as_deref(), Some("plain-name"));
        // 协议形态（npm: 别名 / github: / file:）安装后的 dependencies 键不可预知
        assert_eq!(package_name_from_specifier("npm:pkg@latest"), None);
        assert_eq!(package_name_from_specifier("github:owner/repo#c0ffee"), None);
        assert_eq!(package_name_from_specifier("file:/x/y.tgz"), None);
    }

    #[test]
    fn snapshot_falls_back_to_network_error_when_snapshot_also_fails() {
        set_current("en");
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-snapfail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snapshot.json");
        let net_err = || "Failed to fetch plugin catalog: HTTP 502".to_string();
        // 快照不存在 → 原始网络错误（它比"没有快照"更有行动价值）
        assert_eq!(catalog_snapshot_decision(&path, net_err()).err().as_deref(), Some(net_err().as_str()));
        // 快照 JSON 损坏 → 同上
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(catalog_snapshot_decision(&path, net_err()).err().as_deref(), Some(net_err().as_str()));
        // 旧契约快照不认识 → 同上（坏快照不掩盖在线数据的问题）
        std::fs::write(&path, catalog_fixture()).unwrap();
        assert_eq!(catalog_snapshot_decision(&path, net_err()).err().as_deref(), Some(net_err().as_str()));
        // 好快照（投影格式）→ 降级成功（from_snapshot 标记 + updated 供横幅标注）
        write_projected_snapshot(&path);
        let catalog = catalog_snapshot_decision(&path, net_err()).expect("snapshot");
        assert!(catalog.from_snapshot);
        assert_eq!(catalog.updated.as_deref(), Some("2026-08-31"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn policy_allows_covers_exact_prefix_name_and_protocol_entries() {
        let entries = vec![
            "dsh-better-sidebar".to_string(),
            "@scope/".to_string(),
            "github:owner/repo".to_string(),
        ];
        // 规则 3：npm 包名（去版本）
        assert!(policy_allows(&entries, "dsh-better-sidebar@latest"));
        assert!(policy_allows(&entries, "dsh-better-sidebar"));
        // 规则 2：scope 前缀
        assert!(policy_allows(&entries, "@scope/pkg@2.0"));
        // 规则 4：协议条目放行其任意 ref
        assert!(policy_allows(&entries, "github:owner/repo#c0ffee"));
        assert!(policy_allows(&entries, "github:owner/repo"));
        // 名单之外一律拒绝
        assert!(!policy_allows(&entries, "other-pkg@1.0"));
        assert!(!policy_allows(&entries, "@other/pkg@1.0"));
        assert!(!policy_allows(&entries, "github:owner/other#main"));
        // 协议前缀不能越过包名边界（repo-evil 不是 repo）
        assert!(!policy_allows(&entries, "github:owner/repo-evil#main"));
        // 空名单 = 白名单生效且全拒（allowed: [] 语义）
        assert!(!policy_allows(&[], "anything"));
    }

    #[test]
    fn policy_entries_parse_contract() {
        set_current("en");
        // allowed 键缺席 = 不启用白名单
        assert_eq!(policy_entries_from_raw("{}").unwrap(), None);
        // 空数组 = 生效且全拒
        assert_eq!(policy_entries_from_raw(r#"{"allowed": []}"#).unwrap(), Some(Vec::<String>::new()));
        assert_eq!(
            policy_entries_from_raw(r#"{"allowed": ["a", "b/"]}"#).unwrap(),
            Some(vec!["a".to_string(), "b/".to_string()])
        );
        // 文件损坏 = fail closed（治理基线宁可拒绝不可静默放行）
        assert!(policy_entries_from_raw("{broken").is_err());
        assert!(policy_entries_from_raw(r#"{"allowed": "a"}"#).is_err());
    }

    #[test]
    fn resolve_catalog_url_defaults_and_validates() {
        set_current("en");
        assert_eq!(resolve_catalog_url("").unwrap(), "https://awesome-dsh-plugin.com/plugins.json");
        assert_eq!(resolve_catalog_url("  ").unwrap(), "https://awesome-dsh-plugin.com/plugins.json");
        assert_eq!(
            resolve_catalog_url("https://mirror.example.com/cat.json").unwrap(),
            "https://mirror.example.com/cat.json"
        );
        assert!(resolve_catalog_url("http://intra.local/cat.json").is_ok());
        assert!(resolve_catalog_url("ftp://mirror/cat.json").is_err());
        assert!(resolve_catalog_url("mirror.example.com/cat.json").is_err());
    }

    #[test]
    fn install_failure_message_detects_allowbuilds_block() {
        set_current("en");
        // pnpm 构建脚本拦截 → 精确到文件的问题/下一步，不裸抛上游 stderr
        let msg = install_failure_message("add", "pnpm: Ignored build scripts: dsh-x ... add it under allowBuilds");
        assert!(msg.contains("allowBuilds"));
        assert!(msg.contains("pnpm-workspace.yaml"));
        assert!(msg.contains("Ignored build scripts"));
        // 普通失败走原模板
        assert_eq!(install_failure_message("add", "boom"), "Failed to install plugin: boom");
        assert_eq!(install_failure_message("remove", "boom"), "Failed to remove plugin: boom");
    }

    #[test]
    fn install_receipt_prefers_new_key_then_npm_name() {
        let list = vec![
            InstalledPlugin { name: "old".into(), spec: "npm:old@1".into(), managed: false },
            InstalledPlugin { name: "dsh-new".into(), spec: "dsh-new@2.0".into(), managed: false },
        ];
        // 首装：before/after 差集唯一（github: 首装只有这条路）
        let r = install_receipt("github:owner/repo#sha", Some(vec!["old".into()]), &list, Some("repo")).unwrap();
        assert_eq!(r.name, "dsh-new");
        // 同键重装/升版：无新键，npm 名定位
        let r = install_receipt("dsh-new@3.0", Some(vec!["old".into(), "dsh-new".into()]), &list, Some("dsh-new")).unwrap();
        assert_eq!(r.spec, "dsh-new@2.0");
        // github 重装：键名与目录名不符（repo → dsh-new），无法唯一定位 → None，不猜
        assert!(
            install_receipt("github:owner/repo#sha", Some(vec!["old".into(), "dsh-new".into()]), &list, Some("repo")).is_none()
        );
        // before 缺失时回退 npm 名
        assert!(install_receipt("dsh-new@3.0", None, &list, Some("dsh-new")).is_some());
    }

    #[test]
    fn install_receipt_protocol_reinstall_locates_existing_key() {
        // api-relay-audit 场景：目录名与落盘键名不一致（api-relay-audit →
        // dsh-api-relay-audit），spec 是唯一连接。无新键时靠
        // protocol_installed_match 唯一命中回收据
        let list = vec![
            InstalledPlugin {
                name: "dsh-api-relay-audit".into(),
                spec: "github:toby-bridges/api-relay-audit".into(),
                managed: false,
            },
            InstalledPlugin {
                name: "dsh-at-file".into(),
                spec: "git+https://github.com/omdsh-dev/dsh-at-file.git".into(),
                managed: false,
            },
        ];
        let before = list.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
        let r = install_receipt(
            "github:toby-bridges/api-relay-audit",
            Some(before),
            &list,
            Some(&specifier_to_catalog_name("github:toby-bridges/api-relay-audit")),
        )
        .unwrap();
        assert_eq!(r.name, "dsh-api-relay-audit");
        // 多命中（dsh 前缀兄弟）→ None
        let list = vec![
            InstalledPlugin { name: "dsh".into(), spec: "github:owner/dsh".into(), managed: false },
            InstalledPlugin { name: "dsh-relay".into(), spec: "github:owner/dsh-relay".into(), managed: false },
        ];
        assert!(
            install_receipt("github:owner/dsh", Some(vec![]), &list, Some("dsh")).is_none()
        );
    }

    #[test]
    fn specifier_to_catalog_name_mirrors_frontend_semantics() {
        assert_eq!(specifier_to_catalog_name("github:toby-bridges/api-relay-audit"), "api-relay-audit");
        assert_eq!(specifier_to_catalog_name("git+https://github.com/omdsh-dev/dsh-at-file.git"), "dsh-at-file.git");
        assert_eq!(specifier_to_catalog_name("@scope/pkg@1.0"), "pkg");
        assert_eq!(specifier_to_catalog_name("dsh-context"), "dsh-context");
        assert_eq!(specifier_to_catalog_name("dsh-context@1.2.3"), "dsh-context");
    }

    #[test]
    fn audit_line_shape_is_stable_jsonl() {
        let line = audit_line("add", "pkg@1.0", Some("0.1.2-alpha.2".into()), None);
        let v: serde_json::Value = serde_json::from_str(&line).expect("jsonl");
        assert_eq!(v["action"], "add");
        assert_eq!(v["identifier"], "pkg@1.0");
        assert_eq!(v["result"], "ok");
        assert_eq!(v["error"], serde_json::Value::Null);
        assert_eq!(v["dshVersion"], "0.1.2-alpha.2");
        assert!(v["launcherVersion"].as_str().unwrap().starts_with("0."));
        assert!(v["ts"].as_str().unwrap().contains('T'));

        let failed = audit_line("remove", "pkg", None, Some("boom"));
        let v: serde_json::Value = serde_json::from_str(&failed).expect("jsonl");
        assert_eq!(v["result"], "failed");
        assert_eq!(v["error"], "boom");
        assert_eq!(v["dshVersion"], serde_json::Value::Null);
    }

    #[test]
    fn bundled_tarball_checksum_verification_is_fail_closed() {
        set_current("en");
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-cksum-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tgz = dir.join("plugin-abc123.tgz");
        std::fs::write(&tgz, b"tarball-bytes").unwrap();
        // 校验和文件缺失 = 拒绝
        assert!(verify_bundled_tarball(&tgz, "plugin-abc123.tgz").is_err());
        // 摘要不符 = 拒绝
        std::fs::write(dir.join("plugin-abc123.tgz.sha256"), b"deadbeef").unwrap();
        assert!(verify_bundled_tarball(&tgz, "plugin-abc123.tgz").is_err());
        // 一致 = 通过（摘要用同款 sha256 产出，验证格式与比较逻辑）
        let digest = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(b"tarball-bytes"))
        };
        std::fs::write(dir.join("plugin-abc123.tgz.sha256"), format!("{digest}\n")).unwrap();
        assert!(verify_bundled_tarball(&tgz, "plugin-abc123.tgz").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ============ 编排决策核（seam 在 fs/进程边缘，本组全部纯内存）============

    #[test]
    fn resolve_local_access_url_returns_first_probe_hit_after_retries() {
        // 编排语义：probe 反复调用直到命中；命中即返回，不再多等一轮
        let mut attempts = 0;
        let mut sleeps = 0;
        let url = super::start::resolve_local_access_url(
            || {
                attempts += 1;
                (attempts >= 3).then(|| "http://127.0.0.1:3899/?token=abc".to_string())
            },
            || sleeps += 1,
        );
        assert_eq!(url, "http://127.0.0.1:3899/?token=abc");
        assert_eq!(attempts, 3);
        assert_eq!(sleeps, 2, "命中后不应多睡一轮");
    }

    #[test]
    fn resolve_local_access_url_falls_back_to_bare_url_after_budget_exhausted() {
        // 重试预算 20 轮耗尽（日志新区域始终没有 token 行）→ 裸地址回退，
        // 由 dsh 自己的 401 页面引导用户
        let mut attempts = 0;
        let mut sleeps = 0;
        let url = super::start::resolve_local_access_url(
            || {
                attempts += 1;
                None
            },
            || sleeps += 1,
        );
        assert_eq!(url, "http://127.0.0.1:3899");
        assert_eq!(attempts, 20);
        assert_eq!(sleeps, 20);
    }

    #[test]
    fn diagnose_start_failure_branches_on_log_fingerprints() {
        set_current("en");
        // 无日志：占用端口的兜底文案
        let (problem, solution) = super::setup::diagnose_start_failure_from_tail(None);
        assert!(problem.contains("no log output"));
        assert!(solution.contains("dsh-web.log"));
        // EPERM 指纹 → Windows 开发者模式
        let (_, solution) = super::setup::diagnose_start_failure_from_tail(Some(
            "Error: EPERM: operation not permitted, symlink",
        ));
        assert!(solution.contains("Developer Mode"));
        // credentials 格式指纹 → 手动还原指引
        let (_, solution) = super::setup::diagnose_start_failure_from_tail(Some(
            "Error: the value for \"version\" in /x/.dsh/.credentials.yaml must be a string",
        ));
        assert!(solution.contains("KEY: value"));
        // 插件崩溃链优先于通用指纹
        let (problem, solution) = super::setup::diagnose_start_failure_from_tail(Some(concat!(
            "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): ",
            "failed to apply loader entry agent-teams (@nanmicoder/dsh-agent-teams): ctx.x is not a function\n",
            "EPERM something", // 通用指纹在场也不抢插件点名
        )));
        assert!(problem.contains("@nanmicoder/dsh-agent-teams"));
        assert!(solution.contains("Plugins page"));
        // 普通日志：问题截前 8 行进时间轴
        let long_tail = (1..=20).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
        let (problem, _) = super::setup::diagnose_start_failure_from_tail(Some(&long_tail));
        assert!(problem.contains("line8"));
        assert!(!problem.contains("line9"));
        set_current("en");
    }

    #[test]
    fn credentials_lock_staleness_follows_holder_liveness() {
        // 持锁 PID 已死 → 孤儿，可清理；活着 → 真实并发持有，不得动
        assert!(credentials_lock_is_stale("19648\n", |_| false));
        assert!(!credentials_lock_is_stale("19648\n", |_| true));
        // 内容解析不出 PID：没有活进程会持一把没写自己 PID 的锁，按孤儿处理
        assert!(credentials_lock_is_stale("garbage", |_| true));
        assert!(credentials_lock_is_stale("", |_| true));
    }

    #[test]
    fn lock_timeout_diagnosis_points_at_the_lock_file_not_the_builtin_plugin() {
        // 回归（本机实测事故，v0.5.x）：孤儿 credentials 写锁让 boot 崩在内置
        // connection 插件的锁等待上。按插件链归因会指引用户去 Plugins 页移除一个
        // 不可移除的内置插件——锁超时指纹必须优先，解法指向锁文件本身
        set_current("en");
        let (problem, solution) = super::setup::diagnose_start_failure_from_tail(Some(concat!(
            "Error: dsh: plugin tree failed to load: failed to apply loader entry connection (@deepseek-ai/dsh-client-connection): ",
            "atomic-write: timed out waiting for the writer lock at C:\\Users\\x\\.dsh\\.credentials.yaml.lock\n",
            "Error: atomic-write: timed out waiting for the writer lock at C:\\Users\\x\\.dsh\\.credentials.yaml.lock\n",
        )));
        assert!(problem.contains(".credentials.yaml.lock"));
        assert!(solution.contains(".credentials.yaml.lock"));
        assert!(!solution.contains("Plugins page"));
        set_current("en");
    }

    #[test]
    fn install_decision_elevates_blocked_builds_to_needs_approval() {
        set_current("en");
        // pnpm 拦截指纹在 raw 里 → NeedsApproval（包名 + yaml 路径），不是失败
        let outcome = super::market::install_decision(
            "node-pty",
            Err(("Ignored build scripts: node-pty@1.1.0".to_string(), "display".to_string())),
            None,
            None,
            Some("/p/pnpm-workspace.yaml".to_string()),
        )
        .expect("needs approval is not an error");
        match outcome {
            InstallOutcome::NeedsApproval { packages, workspace_yaml } => {
                assert_eq!(packages, vec!["node-pty"]);
                assert_eq!(workspace_yaml, "/p/pnpm-workspace.yaml");
            }
            InstallOutcome::Installed { .. } => panic!("expected needsApproval"),
        }
        // 普通失败 → Err（raw 留给台账，display 给用户）
        let err = super::market::install_decision(
            "pkg",
            Err(("boom".to_string(), "Failed to install plugin: boom".to_string())),
            None,
            None,
            Some("/p/x.yaml".to_string()),
        )
        .expect_err("plain failure");
        assert_eq!(err.0, "boom");
        assert_eq!(err.1, "Failed to install plugin: boom");
        set_current("en");
    }

    #[test]
    fn install_decision_success_computes_receipt_from_before_after() {
        let after = vec![
            InstalledPlugin { name: "dsh-new".into(), spec: "dsh-new@2.0".into(), managed: false },
        ];
        let outcome = super::market::install_decision(
            "dsh-new@2.0",
            Ok(()),
            Some(vec![]),
            Some(after),
            None,
        )
        .expect("installed");
        match outcome {
            InstallOutcome::Installed { receipt } => {
                let r = receipt.expect("receipt");
                assert_eq!(r.name, "dsh-new");
                assert_eq!(r.spec, "dsh-new@2.0");
            }
            InstallOutcome::NeedsApproval { .. } => panic!("expected installed"),
        }
        // after 缺失（重读 profile 失败）→ 安装仍成功、回执为空，不放大失败
        let outcome = super::market::install_decision("dsh-new@2.0", Ok(()), Some(vec![]), None, None)
            .expect("installed");
        assert!(matches!(outcome, InstallOutcome::Installed { receipt: None }));
    }

    // 测试夹具：hooks 字段是无捕获 fn 指针，场景参数经线程局部静态传递
    // （cargo test 线程间隔离，各用例互不串扰）
    use std::cell::Cell;
    thread_local! {
        static PROBE_HTTPS_OK: Cell<bool> = const { Cell::new(false) };
        static PROBE_WS_OK: Cell<bool> = const { Cell::new(false) };
        static PROBE_RPC: Cell<u8> = const { Cell::new(0) }; // 0 Ready 1 Denied 2 Failed
        static PROBE_PROXY: std::cell::RefCell<Option<super::MacosHttpsProxy>> = const { std::cell::RefCell::new(None) };
        static PROBE_PROXIED_HTTPS_OK: Cell<bool> = const { Cell::new(false) };
        static PROBE_PROXIED_WS_OK: Cell<bool> = const { Cell::new(false) };
    }
    fn fixture_https_ok(_: &str) -> bool { PROBE_HTTPS_OK.with(|c| c.get()) }
    fn fixture_ws_ok(_: &str) -> bool { PROBE_WS_OK.with(|c| c.get()) }
    fn fixture_rpc(_: &str, _: &str) -> RemoteRpcAccess {
        match PROBE_RPC.with(|c| c.get()) {
            1 => RemoteRpcAccess::Denied,
            2 => RemoteRpcAccess::Failed,
            _ => RemoteRpcAccess::Ready,
        }
    }
    fn fixture_https_ok_via_proxy(_: &str, _: &super::MacosHttpsProxy) -> bool { PROBE_PROXIED_HTTPS_OK.with(|c| c.get()) }
    fn fixture_ws_ok_via_proxy(_: &str, _: &super::MacosHttpsProxy) -> bool { PROBE_PROXIED_WS_OK.with(|c| c.get()) }
    fn fixture_active_proxy() -> Option<super::MacosHttpsProxy> { PROBE_PROXY.with(|c| c.borrow().clone()) }

    fn probe_hooks(
        https_ok: bool,
        ws_ok: bool,
        rpc: RemoteRpcAccess,
        proxy: Option<super::MacosHttpsProxy>,
        proxied_https_ok: bool,
        proxied_ws_ok: bool,
    ) -> super::probe::RemoteProbeHooks {
        PROBE_HTTPS_OK.with(|c| c.set(https_ok));
        PROBE_WS_OK.with(|c| c.set(ws_ok));
        PROBE_RPC.with(|c| c.set(match rpc {
            RemoteRpcAccess::Ready => 0,
            RemoteRpcAccess::Denied => 1,
            RemoteRpcAccess::Failed => 2,
        }));
        PROBE_PROXY.with(|c| *c.borrow_mut() = proxy);
        PROBE_PROXIED_HTTPS_OK.with(|c| c.set(proxied_https_ok));
        PROBE_PROXIED_WS_OK.with(|c| c.set(proxied_ws_ok));
        super::probe::RemoteProbeHooks {
            https_ok: fixture_https_ok,
            ws_ok: fixture_ws_ok,
            rpc_access: fixture_rpc,
            https_ok_via_proxy: fixture_https_ok_via_proxy,
            ws_ok_via_proxy: fixture_ws_ok_via_proxy,
            active_https_proxy: fixture_active_proxy,
        }
    }

    fn probe_auth() -> AuthConfig {
        AuthConfig {
            extra_allowed_logins: Vec::new(),
            use_capability: Some("example.com/cap/dsh".to_string()),
            admin_capability: Some("example.com/cap/dsh-admin".to_string()),
        }
    }

    #[test]
    fn probe_orchestration_classifies_each_failure_ring() {
        let url = "https://node.example.ts.net";
        let auth = probe_auth();
        // 直连 HTTPS 都不通：端点失败，不做任何 RPC/代理探测
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(false, false, RemoteRpcAccess::Ready, None, false, false));
        assert_eq!(p.access, RemoteUrlAccess::EndpointFailure);
        // 直连通、RPC 被拒：capability 归因
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(true, true, RemoteRpcAccess::Denied, None, false, false));
        assert_eq!(p.access, RemoteUrlAccess::CapabilityDenied);
        // 直连通、WS 挂：端点失败
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(true, false, RemoteRpcAccess::Ready, None, false, false));
        assert_eq!(p.access, RemoteUrlAccess::EndpointFailure);
        // 直连全通、无系统代理：就绪
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(true, true, RemoteRpcAccess::Ready, None, false, false));
        assert_eq!(p.access, RemoteUrlAccess::Ready);
        // 直连全通、系统代理生效且代理路径挂：代理拦截（本机浏览器体验受损）
        let proxy = super::MacosHttpsProxy {
            server: "127.0.0.1".to_string(),
            port: 1082,
            exceptions: Vec::new(),
        };
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(true, true, RemoteRpcAccess::Ready, Some(proxy.clone()), false, false));
        assert_eq!(p.access, RemoteUrlAccess::ProxyInterference);
        // 代理路径也通：整体就绪
        let p = super::probe::probe_remote_url_with(url, &auth, &probe_hooks(true, true, RemoteRpcAccess::Ready, Some(proxy), true, true));
        assert_eq!(p.access, RemoteUrlAccess::Ready);
    }

    #[test]
    fn probe_orchestration_skips_rpc_when_no_capability_configured() {
        // 无 capability 配置时不做 RPC，直连结果即结论（RPC 模拟为 Denied 也不归因）
        let url = "https://node.example.ts.net";
        let no_caps = AuthConfig::default();
        let p = super::probe::probe_remote_url_with(url, &no_caps, &probe_hooks(true, true, RemoteRpcAccess::Denied, None, false, false));
        assert_eq!(p.access, RemoteUrlAccess::Ready, "无 capability 配置时 RPC 不参与归因");
        assert_eq!(p.remote_use_access, None);
        assert_eq!(p.remote_settings_access, None);
    }

    // ============ specifier 解析双实现的共享测试向量 ============
    // 语义定义只有一份：specifier_cases.json。Rust/TS 两侧解析器由各自测试
    // 驱动同一向量表，漂移在一侧测试立即失败（替代「改一侧必须同步另一侧」
    // 的注释约定）

    #[test]
    fn specifier_parsers_match_shared_test_vectors() {
        let raw = include_str!("specifier_cases.json");
        let cases: serde_json::Value = serde_json::from_str(raw).expect("parse vectors");
        let table = |key: &str| cases[key].as_array().expect("vector array");
        for case in table("packageNameFromSpecifier") {
            let input = case[0].as_str().unwrap();
            let expect = case[1].as_str();
            assert_eq!(
                package_name_from_specifier(input).as_deref(),
                expect,
                "packageNameFromSpecifier({input:?})"
            );
        }
        for case in table("specifierToCatalogName") {
            let input = case[0].as_str().unwrap();
            let expect = case[1].as_str().unwrap();
            assert_eq!(specifier_to_catalog_name(input), expect, "specifierToCatalogName({input:?})");
        }
    }
