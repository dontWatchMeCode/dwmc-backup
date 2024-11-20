import { $ } from "npm:zx";

import { parse } from "jsr:@std/toml";
import { join as pathJoin } from "jsr:@std/path";

await $`which pigz`.catch(() => {
    throw new Error("pigz not found, please install it.");
});
await $`which tar`.catch(() => {
    throw new Error("tar not found, please install it.");
});
await $`which fzf`.catch(() => {
    throw new Error("fzf not found, please install it.");
});

const HOME_DIR = Deno.env.get("HOME");
if (!HOME_DIR) throw new Error("HOME_DIR not found");
const CONF_FILE = pathJoin(HOME_DIR, ".dwmc-backup.conf");

await Deno.lstat(CONF_FILE).catch(async () => {
    console.log(
        "\n~/.dwmc-backup.conf not found\n\n",
        "Please create ~/.dwmc-backup.conf with the following content:\n",
        "> SOURCE_DIR='<absolute_path_to_source_directory>'\n",
        "> BACKUP_DIR='<absolute_path_to_backup_directory>'\n",
    );

    if (
        confirm("would you like to create a template ~/.dwmc-backup.conf file?")
    ) {
        await Deno.writeTextFile(
            CONF_FILE,
            `SOURCE_DIR='<absolute_path_to_source_directory>'
BACKUP_DIR='<absolute_path_to_backup_directory>'
`,
        );
    }

    Deno.exit(1);
});

const CONF = parse(await Deno.readTextFile(CONF_FILE));
if (!CONF.BACKUP_DIR) {
    throw new Error("BACKUP_DIR not found in ~/.dwmc-backup.conf");
}
if (!CONF.SOURCE_DIR) {
    throw new Error("SOURCE_DIR not found in ~/.dwmc-backup.conf");
}

const SOURCE_DIR = String(CONF.SOURCE_DIR);
if (!(await Deno.lstat(SOURCE_DIR)).isDirectory) {
    console.log("SOURCE_DIR is not a directory");
    console.log("> Please create the directory and try again.");
    Deno.exit(1);
}

const BACKUP_DIR = String(CONF.BACKUP_DIR);
await Deno.lstat(BACKUP_DIR).catch(() => {
    console.log("BACKUP_DIR not found, creating...");
    Deno.mkdirSync(BACKUP_DIR, { recursive: true });
    return;
}).then((data) => {
    if (!data) return;
    if (data.isDirectory) return;

    console.log("BACKUP_DIR is not a directory");
    console.log("> Please delete the file and try again.");
    Deno.exit(1);
});

const DIR_SNAPSHOTS_PATH = pathJoin(BACKUP_DIR, "snapshots");
const DIR_RESTORE_PATH = pathJoin(BACKUP_DIR, "restore");

const FILE_SNAR_PATH = pathJoin(BACKUP_DIR, "backup.snar");
const FILE_LOG_PATH = pathJoin(BACKUP_DIR, "_backup.log");
const FILE_ERROR_PATH = pathJoin(BACKUP_DIR, "_error.log");

const UNIX_TIMESTAMP = Math.floor(Date.now() / 1000);

await Deno.mkdir(DIR_SNAPSHOTS_PATH, { recursive: true });

async function log(message: string, isError = false) {
    await Deno.lstat(FILE_LOG_PATH).catch(() => {
        Deno.createSync(FILE_LOG_PATH);
    });

    await Deno.lstat(FILE_ERROR_PATH).catch(() => {
        Deno.createSync(FILE_ERROR_PATH);
    });

    let logFile = FILE_LOG_PATH;
    if (isError) logFile = FILE_ERROR_PATH;

    console.log(message);
    await Deno.writeTextFile(
        logFile,
        `[${new Date().toLocaleString()}] ${message}\n`,
        {
            append: true,
        },
    );
}

async function backup() {
    const backup_file = pathJoin(
        DIR_SNAPSHOTS_PATH,
        `backup_${UNIX_TIMESTAMP}.tar.gz`,
    );

    log(`Creating incremental backup: ${backup_file}`);
    await $`tar --use-compress-program="pigz -k " --verbose --create --file=${backup_file} --listed-incremental=${FILE_SNAR_PATH} ${SOURCE_DIR}`
        .verbose();
    log(`Backup completed: ${backup_file}`);
}

async function restore() {
    const backupFiles = [];
    for await (const post of Deno.readDir(DIR_SNAPSHOTS_PATH)) {
        backupFiles.push(post.name);
    }

    const backupChoices = backupFiles
        .filter((file) =>
            file.startsWith("backup_") && file.endsWith(".tar.gz")
        )
        .sort((a, b) => b.localeCompare(a));

    if (backupChoices.length === 0) {
        console.log("No backups found.");
        return;
    }

    const mappedBackupChoices = backupChoices.map((file) => {
        let temp = file;
        temp = temp.replaceAll(".tar.gz", "");
        temp = temp.replaceAll("backup_", "");
        temp = temp.replaceAll("_", ".");
        const date = new Date(UNIX_TIMESTAMP * 1000);

        return file + " (" + date.toISOString() + ")";
    });

    const { stdout: mappedBackupChoicesSelected } = await $`echo ${
        mappedBackupChoices.join("\n")
    } | fzf`;

    const selectedIndex = mappedBackupChoices.indexOf(
        mappedBackupChoicesSelected.replaceAll("\n", "").trim(),
    );

    const selectedFile = backupChoices[selectedIndex];
    const selectedFilePath = pathJoin(DIR_SNAPSHOTS_PATH, selectedFile);
    await Deno.lstat(selectedFilePath);

    if (selectedFile) {
        await Deno.remove(DIR_RESTORE_PATH, { recursive: true }).catch(
            () => {},
        );
        await Deno.mkdir(DIR_RESTORE_PATH, { recursive: true });

        for (const _currentFile of backupChoices.reverse()) {
            log(`Restoring incremental backup: ${_currentFile}`);
            await $`tar --use-compress-program="pigz -k " --verbose --extract --file=${
                pathJoin(DIR_SNAPSHOTS_PATH, _currentFile)
            } -C ${DIR_RESTORE_PATH}`.verbose();

            if (_currentFile == selectedFile) break;
        }

        log("Restore completed.");
    } else {
        console.log("No backup selected. Restore aborted.");
    }
}

async function main() {
    const action = Deno.args[0];

    switch (action) {
        case "backup":
            await backup();
            break;
        case "restore":
            await restore();
            break;
        default:
            console.log("usage: {backup|restore}");
            Deno.exit(1);
    }
}

try {
    await main();
    // deno-lint-ignore no-explicit-any
} catch (err: any) {
    if (err.exitCode == 130) {
        console.log("Interrupt, exiting...");
        Deno.exit(0);
    }

    await log(`Error: ${err.message}`, true);
    await log(`Stack trace: ${err.stack}`, true);
    Deno.exit(1);
}
