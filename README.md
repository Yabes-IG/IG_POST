# IG_POST — Daily Instagram Reels Publisher

Publish-only pipeline. Render reels locally (or via another repo), drop the
finished `reel.mp4` into `IGPOST/YYMMDD/`, push, and the workflow handles the
rest.

## Folder structure

```
IGPOST/
  260605/                       <-- one folder per publish date (YYMMDD format)
    reel.mp4                    <-- the pre-rendered IG Reel (1080x1920, 48kHz AAC)
    spec.json                   <-- caption + publish settings
  260606/
    reel.mp4
    spec.json
  ...
```

## `spec.json` shape

```json
{
  "caption": "Caption text shown under the IG post.\n\n#hashtag1 #hashtag2",
  "thumbOffsetMs": 5500,
  "title": "Optional short title for GH Release"
}
```

| Field | Required | Notes |
|---|---|---|
| `caption` | yes | The IG post caption. Can include hashtags. |
| `thumbOffsetMs` | no | Millisecond offset for the thumbnail frame (default `1000`). Use the moment a strong frame appears (e.g. after a fade-in). |
| `title` | no | Display title for the GH Release entry. Defaults to "Reel {YYMMDD}". |

## Branch / environment routing

| Branch | Cron-triggered | Default `target` | Result |
|---|---|---|---|
| `main` | (cron runs on default branch only — see workflow) | `production` | Posts to **@vcloudproperty** |
| `staging` | runs daily 09:00 WIB (via main's cron checking out staging content) | `sandbox` | Posts to **@dump.virtual** |

### Editorial flow

1. Drop `IGPOST/YYMMDD/reel.mp4` + `spec.json` on **staging** branch, push.
2. Cron at 09:00 WIB picks today's folder → posts to **@dump.virtual** (sandbox).
3. Review the sandbox post.
4. If good → merge `staging` → `main`, then trigger main's workflow manually (or wait for the next-day cron).

### Direct-to-production override

When you need to post **directly** to @vcloudproperty from the `staging` branch (skip the sandbox dance):

1. Go to **Actions → Post IG Reel → Run workflow**.
2. Select branch: `staging`.
3. Set `target` input to `production`.
4. Run.

The workflow ignores the branch-based default and posts to @vcloudproperty.

## Manual workflow_dispatch inputs

| Input | Default | Description |
|---|---|---|
| `override_folder` | empty (= today's date) | YYMMDD folder name to publish instead of today's. e.g. `260601` to republish an old day. |
| `target` | `auto` | `auto` (branch-based) \| `sandbox` (force @dump.virtual) \| `production` (force @vcloudproperty) |
| `skip_publish` | `false` | Build/upload the GH Release but skip the Graph API call. For testing. |

## Backdated republish (preserve history)

```bash
cp -r IGPOST/260601  IGPOST/$(date +%y%m%d)   # copy old folder to today's date
# edit the copy as needed
git add IGPOST/$(date +%y%m%d) && git commit -m "republish 260601 today" && git push
# at next 09:00 WIB cron, the new dated folder publishes (original 260601 stays untouched)
```

## Secrets

Configured at:
- **Repo level** (shared): `META_APP_ID`, `META_APP_SECRET`
- **Environment `production`**: `IG_USER_ID`, `IG_ACCESS_TOKEN`, `FB_PAGE_ID` (vcloudproperty values)
- **Environment `sandbox`**: `IG_USER_ID`, `IG_ACCESS_TOKEN`, `FB_PAGE_ID` (dump.virtual values)
