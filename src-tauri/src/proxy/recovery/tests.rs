use super::*;

fn system(port: u16) -> SystemProxy {
    SystemProxy::Resolved {
        endpoint: ProxyEndpoint {
            port,
            ..ProxyEndpoint::default()
        },
    }
}
fn coordinator(now: Instant) -> Coordinator {
    let mut state = Coordinator::new(ProxyPreferences::default(), now);
    state.update_system(system(7890), now);
    state.attach(7, now);
    state
}
fn reply(state: &mut Coordinator, request: &Value, result: Value, now: Instant) {
    let mut result = result;
    result["@extra"] = request["@extra"].clone();
    assert!(state.observe(&result, now));
}
fn ok(state: &mut Coordinator, request: &Value, now: Instant) {
    reply(state, request, json!({ "@type": "ok" }), now);
}
fn connection(state: &mut Coordinator, name: &str, now: Instant) {
    assert!(!state.observe(
        &json!({ "@type": "updateConnectionState", "state": { "@type": name } }),
        now
    ));
}
fn verify(state: &mut Coordinator, now: Instant) -> Vec<String> {
    let mut requests = Vec::new();
    for _ in 0..4 {
        let Some(request) = state.next_request(now) else {
            break;
        };
        let kind = request["@type"].as_str().unwrap();
        requests.push(kind.into());
        let response = match kind {
            "pingProxy" => json!({ "@type": "seconds", "seconds": 0.02 }),
            "getCurrentState" => json!({ "@type": "updates", "updates": [
                { "@type": "updateConnectionState", "state": { "@type": READY } }
            ] }),
            _ => json!({ "@type": "ok" }),
        };
        reply(state, &request, response, now);
    }
    assert_eq!(state.phase, "idle");
    assert_eq!(state.state, READY);
    requests
}

#[test]
fn startup_keeps_network_closed_until_proxy_is_applied_and_reopened() {
    let now = Instant::now();
    let mut state = coordinator(now);
    assert_eq!(
        initial_network_request()["type"]["@type"],
        "networkTypeNone"
    );
    assert_eq!(
        verify(&mut state, now),
        ["addProxy", "setNetworkType", "pingProxy", "getCurrentState"]
    );
    assert!(state.initialized);
    assert!(
        state
            .next_request(now + Duration::from_secs(3600))
            .is_none()
    );
}

#[test]
fn command_acknowledgement_and_old_ready_cannot_claim_recovery() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    state.signal(true, now);
    let request = state.next_request(now).unwrap();
    assert_eq!(request["@type"], "setNetworkType");
    connection(&mut state, READY, now);
    ok(&mut state, &request, now);
    assert_eq!(state.phase, "recovering");
    assert!(!state.verified);
    assert_eq!(verify(&mut state, now), ["pingProxy", "getCurrentState"]);
}

#[test]
fn stale_success_or_failure_cannot_commit_an_old_configuration() {
    for response in [
        json!({ "@type": "ok" }),
        json!({ "@type": "error", "code": 400 }),
    ] {
        let now = Instant::now();
        let mut state = coordinator(now);
        let old = state.next_request(now).unwrap();
        state.update_system(system(7891), now);
        // Do not race a second apply ahead of the pending native command.
        assert!(state.next_request(now).is_none());
        reply(&mut state, &old, response, now);
        assert!(!state.initialized);
        assert!(state.error.is_none());
        let current = state.next_request(now).unwrap();
        assert_eq!(current["proxy"]["port"], 7891);
        assert_ne!(current["@extra"], old["@extra"]);
    }
}

#[test]
fn explicit_disable_changes_to_direct_but_discovery_errors_preserve_last_proxy() {
    let now = Instant::now();
    let mut state = coordinator(now);
    for failure in [SystemProxy::Unavailable, SystemProxy::Unsupported] {
        state.update_system(failure, now);
        assert_eq!(state.endpoint().unwrap().unwrap().port, 7890);
    }
    state.update_system(SystemProxy::Disabled, now);
    assert!(state.endpoint().unwrap().is_none());
    assert_eq!(state.next_request(now).unwrap()["@type"], "disableProxy");
    state.update_system(SystemProxy::Unavailable, now);
    assert!(state.endpoint().is_err());
}

#[test]
fn transient_discovery_failure_does_not_reopen_a_healthy_unchanged_route() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    let revision = state.revision;
    for discovery in [
        SystemProxy::Unavailable,
        SystemProxy::Unsupported,
        system(7890),
    ] {
        state.update_system(discovery, now);
        assert_eq!(state.revision, revision);
        assert_eq!(state.phase, "idle");
        assert!(
            state
                .next_request(now + Duration::from_secs(3600))
                .is_none()
        );
    }
}

#[test]
fn starting_without_proxy_then_enabling_system_proxy_reapplies_it() {
    let now = Instant::now();
    let mut state = coordinator(now);
    state.update_system(SystemProxy::Disabled, now);
    assert_eq!(verify(&mut state, now)[0], "disableProxy");
    state.update_system(system(7891), now);
    let request = state.next_request(now).unwrap();
    assert_eq!(request["@type"], "addProxy");
    assert_eq!(request["proxy"]["port"], 7891);
}

#[test]
fn unsupported_initial_proxy_waits_for_configuration_without_direct_fallback() {
    let now = Instant::now();
    let mut state = Coordinator::new(ProxyPreferences::default(), now);
    state.attach(7, now);
    state.update_system(SystemProxy::Unsupported, now);
    assert!(state.next_request(now).is_none());
    assert_eq!(state.phase, "configurationError");
    state.update_system(system(7890), now + DISCOVERY_INTERVAL);
    verify(&mut state, now + DISCOVERY_INTERVAL);
}

#[test]
fn timeout_retry_is_bounded_and_late_response_is_ignored() {
    let mut now = Instant::now();
    let mut state = coordinator(now);
    for expected_delay in [15, 30, 60, 60, 60, 60] {
        let request = state.next_request(now).unwrap();
        now += COMMAND_TIMEOUT;
        assert!(state.next_request(now).is_none());
        assert_eq!(state.retry_delay.as_secs(), expected_delay);
        ok(&mut state, &request, now);
        assert!(!state.initialized);
        now += state.retry_delay;
    }
    verify(&mut state, now);
}

#[test]
fn waiting_for_network_and_syncing_have_native_watchdogs() {
    for (name, delay) in [
        ("connectionStateWaitingForNetwork", CONNECT_GRACE),
        ("connectionStateUpdating", SYNC_GRACE),
    ] {
        let now = Instant::now();
        let mut state = coordinator(now);
        verify(&mut state, now);
        connection(&mut state, name, now);
        assert!(
            state
                .next_request(now + delay - Duration::from_millis(1))
                .is_none()
        );
        assert_eq!(
            state.next_request(now + delay).unwrap()["@type"],
            "setNetworkType"
        );
    }
}

#[test]
fn coalesces_wake_signals_from_multiple_windows_without_changing_proxy() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    for _ in 0..10 {
        state.signal(true, now);
    }
    let reopen = state.next_request(now).unwrap();
    assert_eq!(reopen["@type"], "setNetworkType");
    for _ in 0..10 {
        state.signal(true, now + Duration::from_secs(11));
    }
    assert_eq!(
        state.pending.as_ref().unwrap().extra,
        reopen["@extra"].as_str().unwrap()
    );
    assert_eq!(state.attempt, 1);
}

#[test]
fn switches_custom_profiles_only_after_unsuccessful_attempts() {
    let mut now = Instant::now();
    let mut state = coordinator(now);
    let mut preferences = ProxyPreferences {
        mode: ProxyMode::Custom,
        auto_switch: true,
        ..ProxyPreferences::default()
    };
    let mut backup = preferences.profiles[0].clone();
    backup.id = "backup".into();
    backup.endpoint.port = 7891;
    preferences.profiles.push(backup);
    state.replace_preferences(preferences, now);
    for _ in 0..2 {
        let request = state.next_request(now).unwrap();
        reply(
            &mut state,
            &request,
            json!({ "@type": "error", "code": 400 }),
            now,
        );
        now += state.retry_delay;
    }
    let backup = state.next_request(now).unwrap();
    assert_eq!(backup["proxy"]["port"], 7891);
    assert_eq!(state.runtime_profile, "backup");
    assert_eq!(state.preferences.active_profile_id, "proxy-1");
}

#[test]
fn new_session_discards_pending_work_and_old_client_responses() {
    let now = Instant::now();
    let mut state = coordinator(now);
    let old = state.next_request(now).unwrap();
    state.attach(8, now);
    let current = state.next_request(now).unwrap();
    ok(&mut state, &old, now);
    assert_eq!(
        state.pending.as_ref().unwrap().extra,
        current["@extra"].as_str().unwrap()
    );
    assert!(!state.initialized);
}
