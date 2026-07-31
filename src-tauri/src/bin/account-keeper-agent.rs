use brproxies_launcher_lib::account_keeper_agent::{parse_agent_args, run_agent};

#[tokio::main]
async fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--help" || argument == "-h") {
        println!(
            "Usage: account-keeper-agent --input <file> [--output <file>] [--template <template>] [--timeout-seconds <30-3600>] [--close-profile] [--dry-run]"
        );
        return;
    }

    let exit_code = match parse_agent_args(arguments) {
        Ok(args) => match run_agent(args).await {
            Ok(summary) => {
                let succeeded = summary.succeeded() || summary.status == "validated";
                match serde_json::to_string_pretty(&summary) {
                    Ok(json) => println!("{json}"),
                    Err(error) => eprintln!("Account Keeper agent output failed: {error}"),
                }
                if succeeded { 0 } else { 2 }
            }
            Err(error) => {
                eprintln!("Account Keeper agent failed: {error}");
                1
            }
        },
        Err(error) => {
            eprintln!("Account Keeper agent arguments are invalid: {error}");
            1
        }
    };
    std::process::exit(exit_code);
}
