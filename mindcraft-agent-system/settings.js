// Native agent-system with local connection defaults. Runtime instructions are session-only.
const settings = {
    "minecraft_version": "auto",
    "host": "127.0.0.1",
    "port": 25565,
    "auth": "offline",
    "mindserver_port": 8080,
    "auto_open_ui": false,
    "base_profile": "assistant",
    "profiles": [
        "./andy-reference.json"
    ],
    "use_function_calling": true,
    "use_brain_agent": false,
    "use_rp_agent": true,
    "brain_model": "",
    "task_model": "",
    "rp_model": "",
    "prompt_format": "xml",
    "tool_narration": "periodic",
    "tool_narration_every": 3,
    "tool_narration_max_silence_seconds": 30,
    "brain_check_in_seconds": 60,
    "request_timeout_seconds": 45,
    "model_selection": {
        "enabled": false,
        "default_task_model": "",
        "models": []
    },
    "decisions": {
        "enabled": false,
        "provider": "openrouter",
        "model": "",
        "timeout_ms": 4000,
        "min_confidence": 0.6,
        "min_probability": 0.85,
        "chat_triage": true,
        "task_status": true,
        "goal_check": true
    },
    "usage_budget": {
        "usd_per_session": null,
        "usd_per_day": null,
        "tokens_per_hour": null
    },
    "model_pricing": null,
    "agent_max_steps": 50,
    "agent_max_tool_calls": 80,
    "max_tool_calls_per_response": 12,
    "log_level": "info",
    "log_module_levels": {},
    "load_memory": false,
    "init_message": null,
    "only_chat_with": [],
    "speak": false,
    "chat_ingame": true,
    "language": "en",
    "render_bot_view": true,
    "allow_insecure_coding": false,
    "allow_vision": false,
    "blocked_actions": [
        "!checkBlueprint",
        "!checkBlueprintLevel",
        "!getBlueprint",
        "!getBlueprintLevel"
    ],
    "code_timeout_mins": -1,
    "relevant_docs_count": 5,
    "max_messages": 65,
    "num_examples": 2,
    "max_commands": -1,
    "show_command_syntax": "full",
    "narrate_behavior": true,
    "chat_bot_messages": true,
    "spawn_timeout": 30,
    "block_place_delay": 0,
    "log_all_prompts": false
};

export default settings;
