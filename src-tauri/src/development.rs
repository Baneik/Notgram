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

pub fn environment_value(name: &str) -> Option<String> {
    #[cfg(debug_assertions)]
    {
        return std::env::var(name).ok();
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = name;
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_builds_allow_explicit_development_overrides() {
        assert!(cfg!(debug_assertions));
    }
}
