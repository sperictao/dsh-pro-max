from pathlib import Path

path = Path("src/features/market/MarketView.test.tsx")
text = path.read_text()
old = '''    vi.spyOn(cmd, "marketApproveBuilds").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    useAppStore.setState({'''
new = '''    vi.spyOn(cmd, "marketApproveBuilds").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "dsh-better-sidebar@2.0.0",
        managed: false,
        installedVersion: "2.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
        requiresDsh: null,
        compatible: null,
        updateAvailable: false,
      },
    ]);
    useAppStore.setState({'''
if text.count(old) != 1:
    raise SystemExit(f"expected one approval regression fixture, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
