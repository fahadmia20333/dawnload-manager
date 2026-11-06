export type Status = 'downloading' | 'paused' | 'completed' | 'queued' | 'failed';
export type Category = 'All files' | 'Video' | 'Audio' | 'Documents' | 'Compressed' | 'Programs' | 'Pictures';
export interface Download { id: string; name: string; url: string; category: Category; kind?: 'file' | 'hls'; size: number; downloaded: number; speed: number; status: Status; added: string; eta?: string; type: string; }
