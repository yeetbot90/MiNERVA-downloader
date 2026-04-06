# Minerva ID List

This repository is a list of each of the Minerva archives' file ID's per torrent. As many have probably found, the GUI's from torrenting clients are combersome given the amount of files within each of the dumps. This repo is a way to solve this by providing the id's of each file within each seperate dump that Minerva has saved from the Myrient archive. 

The way that I have found to grab single files is to use Aria2 (https://aria2.github.io/)

## 1. Go and download the torrent from Minerva for the desired dump

https://cdn.minerva-archive.org/torrents/

If you want to download all of the torrents...

```
for i in $(curl -s https://cdn.minerva-archive.org/torrents/ | grep 'href' | awk -F "href=" '{print $2}' | awk -F '>' '{print $1}' | tr -d '"'); do wget -nc https://cdn.minerva-archive.org/torrents/$i; sleep 3 ; done
```

## 2. Go to the markdown file here

Grab the ID(s) for the specific file(s) you want.

## 3. Use aria2c to download the game from the torrent

```
$ aria2c --select-file=<id> --seed-time=0 <torrent_file> -d <directory_to_save_file_to>
```

Example (multiple files):

```
$ aria2c --select-file=1,2,3 --seed-time=0 <torrent_file> -d <directory_to_save_file_to>
```

Note: if you want to seed the files you downloaded remove the `--seed-time=0` from your command.