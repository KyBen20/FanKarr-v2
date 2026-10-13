export type RequestTorrent = {
    url          : string
    magnet       : string | null
    infohash     : string | null
    file_index  ?: number | null
    file_path   ?: string | null
    file_indices?: number[] | null
    file_paths  ?: string[] | null
}

/** Torrents à envoyer : épisodes ciblés, sinon saisons ciblées, sinon toute la série. */
export function resolveRequestTorrents(serieData: any, seasons: number[], episodes: number[]): RequestTorrent[] {
    const toDownload: RequestTorrent[] = []
    const torrentMap = new Map<string, RequestTorrent>()

    const allPackTorrents: any[] = [
        ...(serieData.torrents ?? []),
        ...(serieData.seasons ?? []).flatMap((s: any) => s.torrents ?? []),
    ]

    function addTorrent(t: any, file_index?: number | null, file_path?: string | null) {
        const key = (t.infohash?.toLowerCase()) || t.magnet || t.torrent_url
        if (!key) return

        const existing = torrentMap.get(key)
        if (!existing) {
            const entry: RequestTorrent = {
                url         : t.torrent_url,
                magnet      : t.magnet ?? null,
                infohash    : t.infohash ?? null,
                file_index  : file_index ?? null,
                file_path   : file_path ?? null,
                file_indices: file_index != null ? [file_index] : (file_path ? [] : null),
                file_paths  : file_path ? [file_path] : null,
            }
            torrentMap.set(key, entry)
            toDownload.push(entry)
        } else {
            // Si plusieurs épisodes demandent le même torrent ou si l'un demande tout le torrent sans filtre,
            // on télécharge le torrent complet sans filtre de fichier pour un lancement rapide et complet.
            existing.file_index   = null
            existing.file_path    = null
            existing.file_indices = null
            existing.file_paths   = null
        }
    }

    function addEpisodesByIndex(epList: any[]) {
        for (const ep of epList) {
            if (ep.torrents?.length > 0) {
                addTorrent(ep.torrents[0])
            } else if (ep.paths?.length > 0) {
                const p    = ep.paths[0]
                const pack = allPackTorrents.find((t: any) => t.infohash?.toLowerCase() === p.infohash?.toLowerCase())
                if (pack) addTorrent(pack, p.file_index ?? null, p.path ?? null)
            }
        }
    }

    if (episodes.length > 0) {
        // ── Épisodes ciblés ───────────────────────────────────────
        for (const season of serieData.seasons ?? []) {
            const targets = (season.episodes ?? []).filter((ep: any) => episodes.includes(ep.id))
            addEpisodesByIndex(targets)
        }
    } else if (seasons.length > 0) {
        // ── Saisons ciblées ───────────────────────────────────────
        for (const season of serieData.seasons ?? []) {
            if (!seasons.includes(season.season_number)) continue
            if ((season.torrents ?? []).length > 0) {
                addTorrent(season.torrents[0])
            } else {
                addEpisodesByIndex(season.episodes ?? [])
            }
        }
    } else {
        // ── Toutes les saisons : intégrale en priorité ────────────
        if ((serieData.torrents ?? []).length > 0) {
            addTorrent(serieData.torrents[0])
        } else if ((serieData.seasons ?? []).some((s: any) => s.torrents?.length > 0)) {
            for (const season of serieData.seasons ?? []) {
                if (season.torrents?.length > 0) addTorrent(season.torrents[0])
            }
        } else {
            for (const season of serieData.seasons ?? []) {
                for (const ep of season.episodes ?? []) {
                    if (ep.torrents?.length > 0) {
                        addTorrent(ep.torrents[0])
                    } else if (ep.paths?.length > 0) {
                        const p    = ep.paths[0]
                        const pack = allPackTorrents.find((t: any) => t.infohash?.toLowerCase() === p.infohash?.toLowerCase())
                        if (pack) addTorrent(pack)
                    }
                }
            }
        }
    }

    return toDownload
}

export function countRequestedEpisodes(serieData: any, seasons: number[], episodes: number[]): number {
    const keys = new Set<string>()
    for (const season of serieData.seasons ?? []) {
        for (const ep of season.episodes ?? []) {
            const inScope = episodes.length > 0
                ? episodes.includes(ep.id)
                : seasons.length === 0 || seasons.includes(season.season_number)
            if (inScope) keys.add(`${season.season_number}:${ep.episode_number}`)
        }
    }
    return keys.size
}
