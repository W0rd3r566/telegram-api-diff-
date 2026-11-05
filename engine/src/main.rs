use clap::{Args, Parser, Subcommand};
use std::error::Error;
use std::path::PathBuf;
use telegram_api_diff::runner::{command_check, command_update, SCHEMA_URL};

#[derive(Debug, Parser)]
#[command(
    name = "telegram-api-diff",
    version,
    about = "Track changes in Telegram's official MTProto TL schema"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Fetch the schema, compare it with the baseline, and save a snapshot/report.
    Update(CommonArgs),
    /// Check for schema changes without writing files.
    Check(CommonArgs),
}

#[derive(Debug, Args)]
struct CommonArgs {
    /// Directory containing snapshots/ and reports/.
    #[arg(long, value_name = "PATH", default_value = ".")]
    root: PathBuf,

    /// Machine-readable schema endpoint.
    #[arg(long, default_value = SCHEMA_URL)]
    schema_url: String,

    /// HTTP request timeout in seconds.
    #[arg(long, default_value_t = 30.0)]
    timeout: f64,
}

fn run() -> Result<i32, Box<dyn Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Update(args) => command_update(&args.root, &args.schema_url, args.timeout),
        Commands::Check(args) => command_check(&args.root, &args.schema_url, args.timeout),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(2);
        }
    }
}
