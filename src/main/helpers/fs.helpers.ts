import { CopyOptions, MoveOptions, RmOptions, copy, createReadStream, ensureDir, move, pathExists, pathExistsSync, realpath, rm, stat, symlink, unlink, unlinkSync, rmSync } from "fs-extra";
import { access, mkdir, readdir, lstat, readlink } from "fs/promises";
import path from "path";
import { Observable, concatMap, from } from "rxjs";
import log from "electron-log";
import crypto from "crypto";
import { execSync } from "child_process";
import { tryit } from "../../shared/helpers/error.helpers";
import { CustomError } from "shared/models/exceptions/custom-error.class";
import { ErrorObject } from "serialize-error";

export async function pathExist(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (e) {
        return false;
    }
}

export async function ensureFolderExist(path: string): Promise<void> {
    if (await pathExist(path)) {
        return Promise.resolve();
    }
    return mkdir(path, { recursive: true })
        .catch(log.error)
        .then(() => {});
}

export async function deleteFile(filepath: string) {
    try {
        log.info("Deleting file", `"${filepath}"`);
        await unlink(filepath);
    } catch (error: any) {
        log.error("Could not delete file", `"${filepath}"`);
        throw CustomError.fromError(error, "generic.fs.delete-file");
    }
}

export function deleteFileSync(filepath: string) {
    try {
        log.info("Deleting file", `"${filepath}"`);
        unlinkSync(filepath);
    } catch (error: any) {
        log.error("Could not delete file", `"${filepath}"`);
        throw CustomError.fromError(error, "generic.fs.delete-file");
    }
}

export async function deleteFolder(folderPath: string, options?: RmOptions) {
    if (!(await pathExist(folderPath))) {
        return;
    }

    try {
        options = options || { recursive: true, force: true };
        log.info("Deleting folder", `"${folderPath}"`, options);
        await rm(folderPath, options);
    } catch (error: any) {
        log.error("Could not delete folder", `"${folderPath}"`);
        throw CustomError.fromError(error, "generic.fs.delete-folder");
    }
}

export function deleteFolderSync(folderPath: string, options?: RmOptions) {
    if (!pathExistsSync(folderPath)) {
        return;
    }

    try {
        options = options || { recursive: true, force: true };
        log.info("Deleting folder", `"${folderPath}"`, options);
        rmSync(folderPath, options);
    } catch (error: any) {
        log.error("Could not delete folder", `"${folderPath}"`);
        throw CustomError.fromError(error, "generic.fs.delete-folder");
    }
}

export async function getFoldersInFolder(folderPath: string, opts?: { ignoreSymlinkTargetError?: boolean }): Promise<string[]> {
    if (!(await pathExist(folderPath))) {
        return [];
    }

    const files = await readdir(folderPath, { withFileTypes: true });

    const promises = files.map(async file => {
        if (file.isDirectory()) {
            return path.join(folderPath, file.name);
        }
        if (!file.isSymbolicLink()) {
            return undefined;
        }
        try {
            const targetPath = await readlink(path.join(folderPath, file.name));
            return (await lstat(targetPath)).isDirectory() ? path.join(folderPath, file.name) : undefined;
        } catch (e: any) {
            if (e.code === "ENOENT" && opts?.ignoreSymlinkTargetError === true && !path.extname(file.name)) {
                return path.join(folderPath, file.name);
            }
            return undefined;
        }
    });

    return (await Promise.all(promises)).filter(folder => folder);
}

export async function getFilesInFolder(folderPath: string): Promise<string[]> {
    if (!(await pathExist(folderPath))) {
        return [];
    }

    const dirEntries = await readdir(folderPath, { withFileTypes: true });

    return dirEntries.filter(entry => entry.isFile()).map(file => path.join(folderPath, file.name));
}

export function moveFolderContent(src: string, dest: string, option?: MoveOptions): Observable<Progression> {
    log.info(`(moveFolderContent) Moving ${src} to ${dest}`);
    const progress: Progression = { current: 0, total: 0 };
    return new Observable<Progression>(subscriber => {
        subscriber.next(progress);
        (async () => {
            const srcExist = await pathExists(src);

            if (!srcExist) {
                return subscriber.complete();
            }

            await ensureFolderExist(dest);

            const files = await readdir(src, { encoding: "utf-8", withFileTypes: true });
            progress.total = files.length;

            for (const file of files) {
                const srcFullPath = path.join(src, file.name);
                const destFullPath = path.join(dest, file.name);

                const srcChilds = file.isDirectory() ? await readdir(srcFullPath, { encoding: "utf-8", recursive: true }) : [];
                const allChildsAlreadyExist = srcChilds.every(child => pathExistsSync(path.join(destFullPath, child)));

                if (file.isFile() || !allChildsAlreadyExist) {
                    const prevSize = await getSize(srcFullPath);
                    await move(srcFullPath, destFullPath, option);
                    const afterSize = await getSize(destFullPath);

                    // The size after moving should be the same or greater than the size before moving but never less
                    if (afterSize < prevSize) {
                        throw new CustomError(`File size mismath. before: ${prevSize}, after: ${afterSize} (${srcFullPath})`, "FILE_SIZE_MISMATCH");
                    }
                } else {
                    log.info(`Skipping ${srcFullPath} to ${destFullPath}, all child already exist in destination`);
                }

                progress.current++;
                subscriber.next(progress);
            }
        })()
            .catch(err => subscriber.error(CustomError.fromError(err, err?.code)))
            .finally(() => subscriber.complete());
    });
}

export function isSubdirectory(parent: string, child: string): boolean {
    const parentNormalized = path.resolve(parent);
    const childNormalized = path.resolve(child);

    if (parentNormalized === childNormalized) {
        return false;
    }

    const relativePath = path.relative(parentNormalized, childNormalized);

    if (path.parse(parentNormalized).root !== path.parse(childNormalized).root) {
        return false;
    }

    return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export async function copyDirectoryWithJunctions(src: string, dest: string, options?: CopyOptions): Promise<void> {
    if (isSubdirectory(src, dest)) {
        throw new CustomError(`Cannot copy directory '${src}' into itself '${dest}'.`, "COPY_TO_SUBPATH");
    }

    await ensureDir(dest);
    const items = await readdir(src, { withFileTypes: true });

    for (const item of items) {
        const sourcePath = path.join(src, item.name);
        const destinationPath = path.join(dest, item.name);

        if (item.isDirectory()) {
            await copyDirectoryWithJunctions(sourcePath, destinationPath, options);
        } else if (item.isFile()) {
            await copy(sourcePath, destinationPath, options);
        } else if (item.isSymbolicLink()) {
            if (options?.overwrite) {
                await deleteFile(destinationPath);
            }
            const symlinkTarget = await readlink(sourcePath);
            const relativePath = path.relative(src, symlinkTarget);
            const newTarget = path.join(dest, relativePath);
            await symlink(newTarget, destinationPath, "junction"); // Only junction to avoid right issues while copying content of BSManager folder
        }
    }
}

export function hashFile(filePath: string, algorithm = "sha256"): Promise<string> {
    return new Promise((resolve, reject) => {
        const shasum = crypto.createHash(algorithm);
        const stream = createReadStream(filePath);
        stream.on("data", data => shasum.update(data));
        stream.on("error", reject);
        stream.on("close", () => resolve(shasum.digest("hex")));
    });
}

export async function dirSize(dirPath: string): Promise<number> {
    const entries = await readdir(dirPath);

    const paths = entries.map(async entry => {
        const fullPath = path.join(dirPath, entry);
        const realPath = await realpath(fullPath);
        const stat = await lstat(realPath);

        if (stat.isDirectory()) {
            return dirSize(fullPath);
        }

        if (stat.isFile()) {
            return stat.size;
        }

        return 0;
    });

    return (await Promise.all(paths)).flat(Infinity).reduce((acc, size) => acc + size, 0);
}

export function rxCopy(src: string, dest: string, option?: CopyOptions): Observable<Progression> {
    const dirSizePromise = dirSize(src).catch(err => {
        log.error("dirSizePromise", err);
        return 0;
    });

    return from(dirSizePromise).pipe(
        concatMap(totalSize => {
            const progress: Progression = { current: 0, total: totalSize };

            return new Observable<Progression>(sub => {
                sub.next(progress);
                copy(src, dest, {
                    ...option,
                    filter: src => {
                        stat(src).then(stats => {
                            progress.current += stats.size;
                            sub.next(progress);
                        });
                        return true;
                    },
                })
                    .then(() => sub.complete())
                    .catch(err => sub.error(err));
            });
        })
    );
}

export async function ensurePathNotAlreadyExist(path: string): Promise<string> {
    let destPath = path;
    let folderExist = await pathExists(destPath);
    let i = 0;

    while (folderExist) {
        i++;
        destPath = `${path} (${i})`;
        folderExist = await pathExists(destPath);
    }

    return destPath;
}

export function ensurePathNotAlreadyExistSync(path: string): string {
    let destPath = path;
    let folderExist = pathExistsSync(destPath);
    let i = 0;

    while (folderExist) {
        i++;
        destPath = `${path} (${i})`;
        folderExist = pathExistsSync(destPath);
    }

    return destPath;
}

export async function isJunction(path: string): Promise<boolean> {
    const [stats, lstats] = await Promise.all([stat(path), lstat(path)]);
    return lstats.isSymbolicLink() && stats.isDirectory();
}

export function resolveGUIDPath(guidPath: string): string {
    const guidVolume = path.parse(guidPath).root;
    const command = `powershell -command "(Get-WmiObject -Class Win32_Volume | Where-Object { $_.DeviceID -like '${guidVolume}' }).DriveLetter"`;
    const { result: driveLetter, error } = tryit(() => execSync(command).toString().trim());
    if (!driveLetter || error) {
        throw new Error("Unable to resolve GUID path", error);
    }
    return path.join(driveLetter, path.relative(guidVolume, guidPath));
}

export function getUniqueFileNamePath(filePath: string): string {
    const { dir, name, ext } = path.parse(filePath);
    let i = 0;
    let newFileName = `${name}${ext}`;

    while (pathExistsSync(path.join(dir, newFileName))) {
        i++;
        newFileName = `${name} (${i})${ext}`;
    }

    return path.join(dir, newFileName);
}

/**
 * @throws {Error} Can throw file system errors
 */
export async function getSize(targetPath: string, maxDepth = 5): Promise<number> {
    const visited = new Set<string>();

    const computeSize = async (currentPath: string, depth: number): Promise<number> => {
        if (visited.has(currentPath)) {
            return 0;
        }

        visited.add(currentPath);

        const stats = await stat(currentPath);

        if (stats.isFile()) {
            return stats.size;
        }

        if (!stats.isDirectory() || depth >= maxDepth) {
            return 0;
        }

        const entries = await readdir(currentPath);
        const sizes = await Promise.all(entries.map(entry => computeSize(path.join(currentPath, entry), depth + 1)));
        return sizes.reduce((acc, cur) => acc + cur, 0);
    };

    return computeSize(targetPath, 0);
}

export interface Progression<T = unknown, D = unknown> {
    total: number;
    current: number;
    diff?: number;
    data?: T;
    extra?: D;
    lastError?: ErrorObject;
}
