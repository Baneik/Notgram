pub fn load_environment() {
    #[cfg(debug_assertions)]
    {
        if let Ok(executable) = std::env::current_exe()
            && let Some(directory) = executable.parent()
        {
            dotenvy::from_path(directory.join(".env")).ok();
        }
        dotenvy::dotenv().ok();
    }
}

#[cfg(debug_assertions)]
pub fn environment_value(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(not(debug_assertions))]
pub fn environment_value(_name: &str) -> Option<String> {
    None
}
