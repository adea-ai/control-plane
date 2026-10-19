CREATE ROLE control_plane_migrator LOGIN NOINHERIT PASSWORD 'local-migration-only';
CREATE ROLE control_plane_app LOGIN NOINHERIT PASSWORD 'local-application-only';
CREATE DATABASE control_plane OWNER control_plane_migrator;
