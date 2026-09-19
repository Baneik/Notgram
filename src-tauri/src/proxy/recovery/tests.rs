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

fn pending_message(message_id: i64, chat_id: i64) -> Value {
    json!({ "@type": "message", "id": message_id, "chat_id": chat_id,
        "is_outgoing": true, "sending_state": { "@type": "messageSendingStatePending" },
        "content": { "@type": "messageText" } })
}

fn upload(bytes: u64, complete: bool) -> Value {
    json!({ "@type": "file", "id": 123, "remote": {
        "uploaded_size": bytes, "is_uploading_completed": complete
    } })
}

#[test]
fn pending_send_reopens_an_unchanged_ready_proxy_without_sending_again() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    state.observe(&pending_message(-1, 7), now);
    assert!(!state.update_system(system(7890), now + Duration::from_secs(5)));
    state.signal(false, now + Duration::from_secs(10));
    assert!(state.next_request(now + Duration::from_secs(19)).is_none());
    let request = state.next_request(now + Duration::from_secs(20)).unwrap();
    assert_eq!(request["@type"], "setNetworkType");
    assert_eq!(state.outgoing.count(), 1);
    assert_eq!(state.outgoing.attempts, 1);
}

#[test]
fn short_ready_flaps_and_new_texts_do_not_hide_an_older_stalled_send() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    state.observe(&pending_message(-1, 7), now);
    connection(&mut state, CONNECTING, now + Duration::from_secs(17));
    connection(&mut state, READY, now + Duration::from_secs(18));
    state.observe(&pending_message(-2, 7), now + Duration::from_secs(19));
    assert_eq!(
        state.next_request(now + Duration::from_secs(20)).unwrap()["@type"],
        "setNetworkType"
    );
}

#[test]
fn ready_without_delivery_uses_an_independent_capped_recovery_backoff() {
    let mut now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    state.observe(&pending_message(-1, 7), now);
    now += Duration::from_secs(20);
    for delay in [30, 60, 120, 120] {
        assert_eq!(verify(&mut state, now)[0], "setNetworkType");
        assert!(
            state
                .next_request(now + Duration::from_secs(delay - 1))
                .is_none()
        );
        now += Duration::from_secs(delay);
    }
}

#[test]
fn upload_progress_protects_the_upload_and_texts_queued_in_its_chat() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    let mut message = pending_message(-1, 7);
    message["content"] =
        json!({ "@type": "messageDocument", "document": { "document": upload(0, false) } });
    state.observe(&message, now);
    state.observe(&pending_message(-2, 7), now);
    for seconds in [30, 60, 90, 120] {
        let time = now + Duration::from_secs(seconds);
        state.observe(
            &json!({ "@type": "updateFile", "file": upload(seconds, false) }),
            time,
        );
        assert!(state.next_request(time).is_none());
    }
    // Repeated upload snapshots and download-only changes are not progress.
    state.observe(&message, now + Duration::from_secs(150));
    state.observe(
        &json!({ "@type": "updateFile", "file": upload(120, false) }),
        now + Duration::from_secs(160),
    );
    assert!(state.next_request(now + Duration::from_secs(164)).is_none());
    assert_eq!(
        state.next_request(now + Duration::from_secs(165)).unwrap()["@type"],
        "setNetworkType"
    );
}

#[test]
fn upload_completion_starts_the_delivery_confirmation_grace() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    let mut message = pending_message(-1, 7);
    message["content"] = json!({ "file": upload(0, false) });
    state.observe(&message, now);
    state.observe(
        &json!({ "@type": "updateFile", "file": upload(500, true) }),
        now + Duration::from_secs(40),
    );
    assert!(state.next_request(now + Duration::from_secs(59)).is_none());
    assert_eq!(
        state.next_request(now + Duration::from_secs(60)).unwrap()["@type"],
        "setNetworkType"
    );
}

#[test]
fn completed_upload_leaves_confirmation_time_for_queued_texts() {
    for kind in ["updateMessageSendSucceeded", "updateMessageSendFailed"] {
        let now = Instant::now();
        let mut state = coordinator(now);
        verify(&mut state, now);
        let mut message = pending_message(-1, 7);
        message["content"] = json!({ "file": upload(0, false) });
        state.observe(&message, now);
        state.observe(&pending_message(-2, 7), now);
        state.observe(
            &json!({ "@type": kind, "old_message_id": -1,
                "message": { "chat_id": 7, "id": 20 } }),
            now + Duration::from_secs(40),
        );
        assert_eq!(state.outgoing.count(), 1);
        assert!(state.next_request(now + Duration::from_secs(59)).is_none());
        assert_eq!(
            state.next_request(now + Duration::from_secs(60)).unwrap()["@type"],
            "setNetworkType"
        );
    }
}

#[test]
fn text_link_preview_files_do_not_extend_the_send_grace() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    let mut message = pending_message(-1, 7);
    message["content"]["link_preview"] = json!({ "photo": upload(0, false) });
    state.observe(&message, now);
    state.observe(
        &json!({ "@type": "updateFile", "file": upload(500, false) }),
        now + Duration::from_secs(19),
    );
    assert_eq!(
        state.next_request(now + Duration::from_secs(20)).unwrap()["@type"],
        "setNetworkType"
    );
}

#[test]
fn terminal_send_updates_stop_recovery_and_ignore_late_pending_snapshots() {
    for kind in [
        "updateMessageSendSucceeded",
        "updateMessageSendFailed",
        "updateDeleteMessages",
    ] {
        let now = Instant::now();
        let mut state = coordinator(now);
        verify(&mut state, now);
        let pending = pending_message(-1, 7);
        state.observe(&pending, now);
        state.observe(
            &json!({ "@type": kind, "old_message_id": -1, "message": { "chat_id": 7, "id": 20 },
            "chat_id": 7, "message_ids": [-1], "is_permanent": true }),
            now,
        );
        state.observe(&pending, now + Duration::from_secs(30));
        assert_eq!(state.outgoing.count(), 0);
        assert!(
            state
                .next_request(now + Duration::from_secs(3600))
                .is_none()
        );
    }
}

#[test]
fn cached_pending_sends_resume_monitoring_but_scheduled_and_incoming_do_not() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    let mut scheduled = pending_message(-2, 7);
    scheduled["is_scheduled"] = json!(true);
    let mut incoming = pending_message(-3, 7);
    incoming["is_outgoing"] = json!(false);
    state.observe(
        &json!({ "@type": "messages", "messages": [pending_message(-1, 7), scheduled, incoming] }),
        now,
    );
    state.observe(
        &json!({ "@type": "updateDeleteMessages", "chat_id": 7,
        "message_ids": [-1], "is_permanent": false, "from_cache": true }),
        now,
    );
    assert_eq!(state.outgoing.count(), 1);
    assert_eq!(
        state.next_request(now + Duration::from_secs(20)).unwrap()["@type"],
        "setNetworkType"
    );
    state.attach(8, now + Duration::from_secs(30));
    verify(&mut state, now + Duration::from_secs(30));
    assert_eq!(state.outgoing.count(), 0);
    assert!(
        state
            .next_request(now + Duration::from_secs(3600))
            .is_none()
    );
}

#[test]
fn pending_sends_do_not_bypass_an_existing_failed_recovery_backoff() {
    let now = Instant::now();
    let mut state = coordinator(now);
    verify(&mut state, now);
    state.observe(&pending_message(-1, 7), now);
    let reopen = state.next_request(now + Duration::from_secs(20)).unwrap();
    reply(
        &mut state,
        &reopen,
        json!({ "@type": "error", "code": 500 }),
        now + Duration::from_secs(20),
    );
    assert!(state.next_request(now + Duration::from_secs(34)).is_none());
    assert_eq!(
        state.next_request(now + Duration::from_secs(35)).unwrap()["@type"],
        "setNetworkType"
    );
}
