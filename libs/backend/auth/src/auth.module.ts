import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceEntity, UserEntity } from '@plaudern/persistence';
import { AuthService } from './auth.service';
import { DeviceAuthGuard } from './device-auth.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity, UserEntity])],
  providers: [AuthService, DeviceAuthGuard],
  exports: [AuthService, DeviceAuthGuard],
})
export class AuthModule {}
