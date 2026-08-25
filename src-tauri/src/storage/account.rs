use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub const DEFAULT_ACCOUNT_ID: &str = "default";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAvatar {
    pub label: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_download: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_downloading: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccount {
    pub id: String,
    pub user_id: String,
    pub display_name: String,
    pub avatar: AccountAvatar,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccountRegistration {
    pub user_id: String,
    pub display_name: String,
    pub avatar: AccountAvatar,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAccountState {
    pub active_account_id: String,
    pub accounts: Vec<TelegramAccount>,
}

fn preserve_avatar_media(incoming: &mut AccountAvatar, existing: &AccountAvatar) {
    let same_file = incoming.file_id.is_some() && existing.file_id == incoming.file_id;
    if incoming.image_path.is_none() && same_file {
        incoming.image_path = existing.image_path.clone();
    }
    if incoming.file_id.is_none() {
        incoming.file_id = existing.file_id;
    }
    if incoming.can_download.is_none() {
        incoming.can_download = existing.can_download;
    }
    if incoming.is_downloading.is_none() {
        incoming.is_downloading = existing.is_downloading;
    }
}

fn trusted_avatar_path(path: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let path = PathBuf::from(path).canonicalize().ok()?;
    roots
        .iter()
        .any(|root| path.starts_with(root) && path.is_file())
        .then_some(path)
}

fn authorize_registered_avatar_assets(
    app: &AppHandle,
    registry: &AccountRegistry,
) -> Result<(), String> {
    let preferences = super::resolve_preferences(app, super::load_preferences(app)?)?;
    let cache_root = PathBuf::from(preferences.cache_path);
    let database_root = crate::distribution::app_data_directory(app)?.join("tdlib");

    for account in &registry.accounts {
        let roots = [
            account_cache_directory(cache_root.clone(), &account.id),
            account_database_directory(database_root.clone(), &account.id),
        ];
        let roots = roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .collect::<Vec<_>>();
        let Some(path) = account
            .avatar
            .image_path
            .as_deref()
            .and_then(|path| trusted_avatar_path(path, &roots))
        else {
            continue;
        };
        // The registry is persisted data, so only authorize an existing file
        // below this account's own TDLib roots.
        let _ = app.asset_protocol_scope().allow_file(&path);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistry {
    active_account_id: String,
    accounts: Vec<TelegramAccount>,
}

impl Default for AccountRegistry {
    fn default() -> Self {
        Self {
            active_account_id: DEFAULT_ACCOUNT_ID.to_string(),
            accounts: Vec::new(),
        }
    }
}

impl From<AccountRegistry> for TelegramAccountState {
    fn from(value: AccountRegistry) -> Self {
        Self {
            active_account_id: value.active_account_id,
            accounts: value.accounts,
        }
    }
}

#[tauri::command]
pub fn telegram_account_state(app: AppHandle) -> Result<TelegramAccountState, String> {
    let registry = load_account_registry(&app)?;
    authorize_registered_avatar_assets(&app, &registry)?;
    Ok(registry.into())
}

#[tauri::command]
pub fn telegram_register_account(
    app: AppHandle,
    account: TelegramAccountRegistration,
) -> Result<TelegramAccountState, String> {
    let mut registry = load_account_registry(&app)?;
    let id = registry.active_account_id.clone();
    validate_account_id(&id)?;
    let mut account = TelegramAccount {
        id: id.clone(),
        user_id: account.user_id,
        display_name: account.display_name,
        avatar: account.avatar,
    };
    if let Some(existing) = registry.accounts.iter_mut().find(|item| item.id == id) {
        // getMe can arrive before TDLib has replayed the completed avatar file.
        // Keep the last known local media reference until the richer file update
        // arrives, otherwise startup replaces a real avatar with initials.
        preserve_avatar_media(&mut account.avatar, &existing.avatar);
        *existing = account;
    } else {
        registry.accounts.push(account);
    }
    save_account_registry(&app, &registry)?;
    authorize_registered_avatar_assets(&app, &registry)?;
    Ok(registry.into())
}

#[tauri::command]
pub fn telegram_select_account(
    app: AppHandle,
    account_id: String,
) -> Result<TelegramAccountState, String> {
    validate_account_id(&account_id)?;
    let mut registry = load_account_registry(&app)?;
    registry.active_account_id = account_id;
    save_account_registry(&app, &registry)?;
    authorize_registered_avatar_assets(&app, &registry)?;
    Ok(registry.into())
}

#[tauri::command]
pub fn telegram_remove_account(
    app: AppHandle,
    account_id: String,
) -> Result<TelegramAccountState, String> {
    validate_account_id(&account_id)?;
    let mut registry = load_account_registry(&app)?;
    registry.accounts.retain(|account| account.id != account_id);
    if registry.active_account_id == account_id {
        registry.active_account_id = registry
            .accounts
            .first()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
    }
    clear_account_storage(&app, &account_id)?;
    save_account_registry(&app, &registry)?;
    Ok(registry.into())
}

pub(super) fn active_account_id(app: &AppHandle) -> Result<String, String> {
    Ok(load_account_registry(app)?.active_account_id)
}

pub(super) fn account_cache_directory(root: PathBuf, account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        root
    } else {
        root.join("accounts").join(account_id)
    }
}

pub(super) fn account_database_directory(root: PathBuf, account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        root.join("database")
    } else {
        root.join("accounts").join(account_id).join("database")
    }
}

fn clear_account_storage(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let app_data_root = crate::distribution::app_data_directory(app)?.join("tdlib");
    let preferences = super::resolve_preferences(app, super::load_preferences(app)?)?;
    let cache_root = PathBuf::from(preferences.cache_path);

    if account_id == DEFAULT_ACCOUNT_ID {
        remove_directory_if_present(&app_data_root.join("database"))?;
        remove_directory_if_present(&cache_root.join("files"))?;
        remove_snapshot_files(&cache_root)?;
    } else {
        remove_directory_if_present(&app_data_root.join("accounts").join(account_id))?;
        remove_directory_if_present(&cache_root.join("accounts").join(account_id))?;
    }
    super::database_key::remove_database_key(app, account_id)?;
    Ok(())
}

fn remove_snapshot_files(directory: &Path) -> Result<(), String> {
    let path = directory.join("notgram-ui-cache.dat");
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    for candidate in [&path, &temporary, &backup] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| {
                format!(
                    "Unable to remove account cache {}: {error}",
                    candidate.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| {
            format!(
                "Unable to remove account directory {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

pub(super) fn validate_account_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid account identifier".to_string());
    }
    Ok(())
}

fn account_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = crate::distribution::app_config_directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create app config directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory.join("accounts.dat"))
}

fn load_account_registry(app: &AppHandle) -> Result<AccountRegistry, String> {
    let path = account_registry_path(app)?;
    let backup = path.with_extension("bak");
    let readable_path = if path.is_file() {
        &path
    } else if backup.is_file() {
        &backup
    } else {
        return Ok(AccountRegistry::default());
    };
    let protected = fs::read(readable_path).map_err(|error| {
        format!(
            "Unable to read account registry {}: {error}",
            readable_path.display()
        )
    })?;
    let serialized = crate::proxy::unprotect(&protected)?;
    let registry: AccountRegistry = serde_json::from_slice(&serialized)
        .map_err(|error| format!("Unable to parse account registry: {error}"))?;
    validate_account_id(&registry.active_account_id)?;
    for account in &registry.accounts {
        validate_account_id(&account.id)?;
    }
    Ok(registry)
}

fn save_account_registry(app: &AppHandle, registry: &AccountRegistry) -> Result<(), String> {
    let path = account_registry_path(app)?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let serialized = serde_json::to_vec(registry)
        .map_err(|error| format!("Unable to serialize account registry: {error}"))?;
    let protected = crate::proxy::protect(&serialized)?;
    fs::write(&temporary, protected).map_err(|error| {
        format!(
            "Unable to write account registry {}: {error}",
            temporary.display()
        )
    })?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Unable to remove account registry backup {}: {error}",
                backup.display()
            )
        })?;
    }
    if path.exists() {
        fs::rename(&path, &backup).map_err(|error| {
            format!(
                "Unable to rotate account registry {}: {error}",
                path.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(format!(
            "Unable to replace account registry {}: {error}",
            path.display()
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolates_secondary_account_directories() {
        let cache_root = PathBuf::from("cache-root");
        let database_root = PathBuf::from("database-root");

        assert_eq!(
            account_cache_directory(cache_root.clone(), DEFAULT_ACCOUNT_ID),
            cache_root
        );
        assert_eq!(
            account_cache_directory(PathBuf::from("cache-root"), "account-2"),
            PathBuf::from("cache-root")
                .join("accounts")
                .join("account-2")
        );
        assert_eq!(
            account_database_directory(database_root.clone(), DEFAULT_ACCOUNT_ID),
            database_root.join("database")
        );
        assert_eq!(
            account_database_directory(PathBuf::from("database-root"), "account-2"),
            PathBuf::from("database-root")
                .join("accounts")
                .join("account-2")
                .join("database")
        );
    }

    #[test]
    fn validates_account_ids_before_using_them_as_paths() {
        assert!(validate_account_id(DEFAULT_ACCOUNT_ID).is_ok());
        assert!(validate_account_id("account-1234_abcd").is_ok());
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id("../account").is_err());
        assert!(validate_account_id("account/child").is_err());
        assert!(validate_account_id(&"a".repeat(81)).is_err());
    }

    #[test]
    fn keeps_avatar_media_metadata_and_reads_legacy_records() {
        let avatar = AccountAvatar {
            label: "工".to_string(),
            color: "#4477aa".to_string(),
            image_path: Some("C:\\avatars\\work.jpg".to_string()),
            file_id: Some(42),
            can_download: Some(true),
            is_downloading: Some(false),
        };
        let serialized = serde_json::to_value(&avatar).expect("avatar should serialize");
        assert_eq!(serialized["imagePath"], "C:\\avatars\\work.jpg");
        assert_eq!(serialized["fileId"], 42);
        assert_eq!(
            serde_json::from_value::<AccountAvatar>(serde_json::json!({
                "label": "工",
                "color": "#4477aa"
            }))
            .expect("legacy avatar should remain readable")
            .image_path,
            None,
        );
    }

    #[test]
    fn preserves_saved_avatar_when_registration_has_no_completed_file() {
        let existing = AccountAvatar {
            label: "工".to_string(),
            color: "#4477aa".to_string(),
            image_path: Some("C:\\avatars\\work.jpg".to_string()),
            file_id: Some(42),
            can_download: Some(true),
            is_downloading: Some(false),
        };
        let incoming = AccountAvatar {
            label: "工".to_string(),
            color: "#4477aa".to_string(),
            image_path: None,
            file_id: Some(42),
            can_download: Some(true),
            is_downloading: Some(true),
        };
        let mut merged = incoming.clone();
        preserve_avatar_media(&mut merged, &existing);
        assert_eq!(merged.image_path.as_deref(), Some("C:\\avatars\\work.jpg"));
        assert_eq!(merged.is_downloading, Some(true));
    }

    #[test]
    fn only_authorizes_avatar_files_inside_the_account_roots() {
        let root = std::env::temp_dir().join(format!(
            "notgram-avatar-roots-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let account_root = root.join("accounts").join("secondary");
        let outside_root = root.join("outside");
        fs::create_dir_all(&account_root).unwrap();
        fs::create_dir_all(&outside_root).unwrap();
        let avatar = account_root.join("avatar.jpg");
        let outside = outside_root.join("avatar.jpg");
        fs::write(&avatar, b"avatar").unwrap();
        fs::write(&outside, b"avatar").unwrap();
        let roots = vec![account_root.canonicalize().unwrap()];

        assert_eq!(
            trusted_avatar_path(&avatar.display().to_string(), &roots),
            Some(avatar.canonicalize().unwrap()),
        );
        assert_eq!(
            trusted_avatar_path(&outside.display().to_string(), &roots),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }
}
